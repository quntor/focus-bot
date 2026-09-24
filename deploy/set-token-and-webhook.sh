#!/bin/sh
set -eu

root_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
env_file="$root_dir/.env.production"
compose_file="$root_dir/compose.prod.yml"

if [ ! -f "$env_file" ]; then
  echo "Missing $env_file" >&2
  exit 1
fi

printf 'Telegram bot token: ' >&2
stty -echo
trap 'stty echo' EXIT INT TERM
IFS= read -r token
stty echo
trap - EXIT INT TERM
printf '\n' >&2

case "$token" in
  *:*) ;;
  *)
    echo 'Token does not look like a Telegram bot token.' >&2
    exit 1
    ;;
esac

umask 077
tmp_file="$env_file.tmp"
found=0
: > "$tmp_file"
while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in
    TELEGRAM_BOT_TOKEN=*)
      printf 'TELEGRAM_BOT_TOKEN=%s\n' "$token" >> "$tmp_file"
      found=1
      ;;
    *) printf '%s\n' "$line" >> "$tmp_file" ;;
  esac
done < "$env_file"
if [ "$found" -ne 1 ]; then
  printf 'TELEGRAM_BOT_TOKEN=%s\n' "$token" >> "$tmp_file"
fi
unset token
mv "$tmp_file" "$env_file"
chmod 600 "$env_file"

cd "$root_dir"
docker compose --env-file .env.production -f "$compose_file" up -d --force-recreate app caddy

domain=''
while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in
    DOMAIN=*) domain=${line#DOMAIN=} ;;
  esac
done < "$env_file"
if [ -z "$domain" ]; then
  echo 'DOMAIN is missing from .env.production.' >&2
  exit 1
fi

attempt=0
while [ "$attempt" -lt 60 ]; do
  if curl --fail --silent --show-error --max-time 5 "https://$domain/healthz" >/dev/null 2>&1; then
    break
  fi
  attempt=$((attempt + 1))
  sleep 2
done
if [ "$attempt" -ge 60 ]; then
  echo "HTTPS health check failed for $domain; webhook was not registered." >&2
  exit 1
fi

docker compose --env-file .env.production -f "$compose_file" run --rm app node dist/scripts/set-webhook.js
