#!/bin/sh
set -eu

root_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
env_file="$root_dir/.env.production"
compose_file="$root_dir/compose.prod.yml"
base_url='https://shared1.multitool.works:4000/v1'
model='gigachat3-10b-a1.8b'
stt_model='whisper-large-v3'

if [ ! -f "$env_file" ]; then
  echo "Missing $env_file" >&2
  exit 1
fi
if [ ! -t 0 ]; then
  echo 'Run this script from an interactive terminal.' >&2
  exit 1
fi

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

umask 077
header_file=$(mktemp)
response_file=$(mktemp)
backup_file=$(mktemp)
tmp_file="$env_file.tmp"
terminal_echo_disabled=0
cleanup() {
  if [ "$terminal_echo_disabled" -eq 1 ]; then stty echo; fi
  rm -f "$header_file" "$response_file" "$backup_file" "$tmp_file"
  unset key
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

printf 'Sber API token: ' >&2
stty -echo
terminal_echo_disabled=1
IFS= read -r key
stty echo
terminal_echo_disabled=0
printf '\n' >&2

if [ "${#key}" -lt 16 ]; then
  echo 'Sber API token looks too short.' >&2
  exit 1
fi

# Проверяем ключ до изменения production-конфигурации. Заголовок лежит только
# во временном root-only файле и не попадает в argv, вывод или shell history.
printf 'Authorization: Bearer %s\n' "$key" > "$header_file"
status=$(curl --silent --show-error --output "$response_file" --write-out '%{http_code}' \
  --connect-timeout 10 --max-time 30 \
  --header "@$header_file" --header 'Accept: application/json' \
  "$base_url/models")
if [ "$status" != '200' ] || ! node -e '
  try {
    const fs = require("node:fs")
    const body = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
    const ids = Array.isArray(body.data) ? body.data.map((item) => item && item.id) : []
    if (!ids.includes(process.argv[2]) || !ids.includes(process.argv[3])) process.exit(1)
  } catch {
    process.exit(1)
  }
' "$response_file" "$model" "$stt_model"; then
  echo "Sber model-list check failed (HTTP $status); production was not changed." >&2
  exit 1
fi

status=$(curl --silent --show-error --output "$response_file" --write-out '%{http_code}' \
  --connect-timeout 10 --max-time 30 \
  --header "@$header_file" --header 'Content-Type: application/json' \
  --data "{\"model\":\"$model\",\"max_tokens\":40,\"temperature\":0,\"messages\":[{\"role\":\"user\",\"content\":\"Ответь одним словом: ok\"}]}" \
  "$base_url/chat/completions")
if [ "$status" != '200' ] || ! node -e '
  try {
    const fs = require("node:fs")
    const body = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
    if (typeof body?.choices?.[0]?.message?.content !== "string") process.exit(1)
  } catch {
    process.exit(1)
  }
' "$response_file"; then
  echo "Sber chat check failed (HTTP $status); production was not changed." >&2
  exit 1
fi

cp "$env_file" "$backup_file"
: > "$tmp_file"
while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in
    LLM_API_KEY=*|LLM_BASE_URL=*|LLM_MODEL=*|STT_MODEL=*) ;;
    *) printf '%s\n' "$line" >> "$tmp_file" ;;
  esac
done < "$env_file"
printf 'LLM_API_KEY=%s\n' "$key" >> "$tmp_file"
printf 'LLM_BASE_URL=%s\n' "$base_url" >> "$tmp_file"
printf 'LLM_MODEL=%s\n' "$model" >> "$tmp_file"
printf 'STT_MODEL=%s\n' "$stt_model" >> "$tmp_file"
unset key
mv "$tmp_file" "$env_file"
chmod 600 "$env_file"

cd "$root_dir"
if ! docker compose --env-file .env.production -f "$compose_file" up -d --build --force-recreate app; then
  cp "$backup_file" "$env_file"
  chmod 600 "$env_file"
  docker compose --env-file .env.production -f "$compose_file" up -d --force-recreate app || true
  echo 'App update failed; previous environment was restored.' >&2
  exit 1
fi

attempt=0
while [ "$attempt" -lt 60 ]; do
  if curl --fail --silent --show-error --max-time 5 "https://$domain/healthz" >/dev/null 2>&1; then
    echo 'LLM enabled; HTTPS health check passed.'
    exit 0
  fi
  attempt=$((attempt + 1))
  sleep 2
done

cp "$backup_file" "$env_file"
chmod 600 "$env_file"
docker compose --env-file .env.production -f "$compose_file" up -d --force-recreate app || true
echo 'HTTPS health check failed; previous environment was restored.' >&2
exit 1
