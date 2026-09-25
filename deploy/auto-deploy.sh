#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

readonly REPOSITORY='quntor/focus-bot'
readonly APP_DIR="${FOCUS_APP_DIR:-/opt/focus-bot}"
readonly BACKUP_ROOT="${FOCUS_BACKUP_ROOT:-/var/backups/focus-bot}"
readonly LOCK_FILE="${FOCUS_DEPLOY_LOCK:-/run/lock/focus-bot-deploy.lock}"
readonly KEEP_BACKUPS="${FOCUS_KEEP_BACKUPS:-5}"
readonly CHECK_ONLY="${FOCUS_DEPLOY_CHECK_ONLY:-0}"

log() {
  printf '%s focus-bot-deploy %s\n' "$(date -u +%FT%TZ)" "$*"
}

die() {
  log "error: $*" >&2
  exit 1
}

for command in curl docker flock git gzip python3 tar; do
  command -v "$command" >/dev/null 2>&1 || die "missing command: $command"
done

exec 9>"$LOCK_FILE"
flock -n 9 || exit 0

desired_sha=$(git ls-remote "https://github.com/${REPOSITORY}.git" refs/heads/main | awk 'NR == 1 { print $1 }')
[[ "$desired_sha" =~ ^[0-9a-f]{40}$ ]] || die 'cannot resolve main SHA'

current_sha=''
if [[ -f "$APP_DIR/.release-commit" ]]; then
  current_sha=$(tr -cd '0-9a-f' < "$APP_DIR/.release-commit")
fi
if [[ -n "$current_sha" && "$desired_sha" == "$current_sha"* ]]; then
  [[ "$CHECK_ONLY" == '1' ]] && log "current ${desired_sha}"
  exit 0
fi

ci_state=$(
  curl --fail --silent --show-error --location --retry 3 \
    --proto '=https' --tlsv1.2 \
    -H 'Accept: application/vnd.github+json' \
    "https://api.github.com/repos/${REPOSITORY}/actions/runs?head_sha=${desired_sha}&event=push&per_page=20" |
    python3 -c '
import json, sys
sha = sys.argv[1]
runs = [r for r in json.load(sys.stdin).get("workflow_runs", []) if r.get("name") == "CI" and r.get("head_sha") == sha]
latest = max(runs, key=lambda r: r.get("run_number", 0), default=None)
if latest and latest.get("status") == "completed" and latest.get("conclusion") == "success":
    print("success")
elif latest and latest.get("status") != "completed":
    print("pending")
elif latest:
    print("failed")
else:
    print("missing")
' "$desired_sha"
)

if [[ "$ci_state" != 'success' ]]; then
  log "skip ${desired_sha}: CI ${ci_state}"
  exit 0
fi
if [[ "$CHECK_ONLY" == '1' ]]; then
  log "ready ${desired_sha}"
  exit 0
fi

[[ "$APP_DIR" == '/opt/focus-bot' ]] || die "unexpected app directory: $APP_DIR"
[[ -f "$APP_DIR/.env.production" ]] || die 'production environment is missing'
[[ $(stat -c '%a' "$APP_DIR/.env.production") == '600' ]] || die 'production environment mode must be 600'

mkdir -p -m 700 "$BACKUP_ROOT"
tmp_dir=$(mktemp -d /opt/.focus-bot-deploy.XXXXXX)
old_dir="$tmp_dir/previous"
deployed=0

rollback() {
  if [[ -d "$old_dir" ]]; then
    log 'rolling back source tree'
    if [[ -d "$APP_DIR" ]]; then
      mv -- "$APP_DIR" "$tmp_dir/failed"
    fi
    mv -- "$old_dir" "$APP_DIR"
    docker compose --env-file "$APP_DIR/.env.production" -f "$APP_DIR/compose.prod.yml" up -d --build --remove-orphans || true
    docker compose --env-file "$APP_DIR/.env.production" -f "$APP_DIR/compose.prod.yml" up -d --force-recreate caddy || true
  fi
}

cleanup() {
  [[ "$tmp_dir" == /opt/.focus-bot-deploy.* ]] || return
  rm -rf -- "$tmp_dir"
}

on_exit() {
  rc=$?
  if [[ $rc -ne 0 && $deployed -eq 0 ]]; then
    rollback
  fi
  cleanup
  exit "$rc"
}
trap on_exit EXIT

archive="$tmp_dir/release.tar.gz"
curl --fail --silent --show-error --location --retry 3 \
  --proto '=https' --tlsv1.2 \
  "https://github.com/${REPOSITORY}/archive/${desired_sha}.tar.gz" \
  --output "$archive"

if tar -tzf "$archive" | grep -Eq '(^/|(^|/)\.\.(/|$))'; then
  die 'unsafe path in release archive'
fi
tar -xzf "$archive" -C "$tmp_dir"
stage_dir="$tmp_dir/focus-bot-${desired_sha}"
[[ -f "$stage_dir/compose.prod.yml" && -f "$stage_dir/package-lock.json" && -x "$stage_dir/deploy/auto-deploy.sh" ]] ||
  die 'release archive is incomplete'

timestamp=$(date -u +%Y%m%dT%H%M%SZ)
backup_dir="$BACKUP_ROOT/${timestamp}-${current_sha:-unknown}-to-${desired_sha:0:8}"
mkdir -m 700 "$backup_dir"

log "backing up ${current_sha:-unknown} before ${desired_sha}"
docker compose --env-file "$APP_DIR/.env.production" -f "$APP_DIR/compose.prod.yml" exec -T db \
  sh -c 'exec pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB"' |
  gzip -9 > "$backup_dir/database.sql.gz"
tar --exclude='./.env.production' --exclude='./.env.production.*' -czf "$backup_dir/source.tar.gz" -C "$APP_DIR" .
install -m 600 "$APP_DIR/.env.production" "$backup_dir/env.production"

mv -- "$APP_DIR" "$old_dir"
mv -- "$stage_dir" "$APP_DIR"
install -m 600 "$backup_dir/env.production" "$APP_DIR/.env.production"
chown -R root:root "$APP_DIR"

docker compose --env-file "$APP_DIR/.env.production" -f "$APP_DIR/compose.prod.yml" config --quiet
log "deploying ${desired_sha}"
docker compose --env-file "$APP_DIR/.env.production" -f "$APP_DIR/compose.prod.yml" up -d --build --remove-orphans

app_id=$(docker compose --env-file "$APP_DIR/.env.production" -f "$APP_DIR/compose.prod.yml" ps -q app)
[[ -n "$app_id" ]] || die 'app container is missing'
healthy=0
for _ in $(seq 1 24); do
  if [[ $(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$app_id") == 'healthy' ]]; then
    healthy=1
    break
  fi
  sleep 5
done
[[ $healthy -eq 1 ]] || die 'app did not become healthy'
docker compose --env-file "$APP_DIR/.env.production" -f "$APP_DIR/compose.prod.yml" up -d --force-recreate caddy

caddy_id=$(docker compose --env-file "$APP_DIR/.env.production" -f "$APP_DIR/compose.prod.yml" ps -q caddy)
[[ -n "$caddy_id" ]] || die 'caddy container is missing'
domain=$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$caddy_id" | sed -n 's/^DOMAIN=//p')
[[ -n "$domain" ]] || die 'DOMAIN is missing'
[[ $(curl --fail --silent --show-error --location --retry 3 --proto '=https' --tlsv1.2 "https://${domain}/healthz") == 'ok' ]] ||
  die 'external health check failed'

printf '%s\n' "$desired_sha" > "$APP_DIR/.release-commit"
chmod 644 "$APP_DIR/.release-commit"
install -m 755 "$APP_DIR/deploy/auto-deploy.sh" /usr/local/sbin/focus-bot-auto-deploy
install -m 644 "$APP_DIR/deploy/focus-bot-auto-deploy.service" /etc/systemd/system/focus-bot-auto-deploy.service
install -m 644 "$APP_DIR/deploy/focus-bot-auto-deploy.timer" /etc/systemd/system/focus-bot-auto-deploy.timer
systemctl daemon-reload

mapfile -t backups < <(find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d -name '20*' -printf '%f\n' | sort -r)
if (( ${#backups[@]} > KEEP_BACKUPS )); then
  for old_backup in "${backups[@]:KEEP_BACKUPS}"; do
    target="$BACKUP_ROOT/$old_backup"
    [[ "$target" == "$BACKUP_ROOT"/20* ]] || die "refusing to remove backup: $target"
    rm -rf -- "$target"
  done
fi

deployed=1
log "deployed ${desired_sha}; backup ${backup_dir}"
