# Развёртывание

## Переменные окружения

Имена — в `.env.example`, значения в репозитории не хранятся. Приложение при старте
проверяет наличие и формат и падает с именем переменной, без значения.

Модель включается только полным набором `LLM_API_KEY`, `LLM_BASE_URL` и
`LLM_MODEL`. Если не задана ни одна из них, бот использует детерминированный
fallback. Для Cloud.ru значения адреса и модели приведены в
[llm.md](llm.md); ключ хранится только в root-only `.env.production`.

`TELEGRAM_WEBHOOK_SECRET` и `TELEGRAM_WEBHOOK_PATH` — две разные случайные строки
из `A-Z a-z 0-9 _ -` длиной 32–256 символов. Например:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

Регистрация вебхука и нативного меню команд — `npm run set-webhook` (нужен
`PUBLIC_URL` с https). Меню регистрируется для личных чатов: его пункт
«Настройки» открывает текущие значения и кнопки изменения. Telegram принимает
вебхуки только на портах 443, 80, 88 и 8443.

## nginx перед приложением

Вебхук принимается только с подсетей Telegram. Диапазоны сверены по документации
Bot API (core.telegram.org/bots/webhooks) 22.09.2026: `149.154.160.0/20` и
`91.108.4.0/22`. Перед выкаткой сверить ещё раз — список может меняться.

```nginx
location /tg/ {
    allow 149.154.160.0/20;
    allow 91.108.4.0/22;
    deny all;

    limit_except POST { deny all; }
    client_max_body_size 1m;
    proxy_read_timeout 10s;

    # Путь вебхука — секрет: не пишем его в access log.
    access_log off;

    proxy_pass http://app:3000;
}

location = /healthz {
    proxy_pass http://app:3000;
}
```

Приложение проверяет секрет в заголовке и само по себе, фильтр по подсетям — второй
рубеж, а не единственный.

## Перед первой выкаткой

- Заменить заглушку текста согласия и ссылку на политику (`src/bot/texts.ts`,
  `PRIVACY_POLICY_URL`) — текст пишет человек.
- Прогнать миграции: `npx prisma migrate deploy`.

## Production Compose

Production-контур описан в `compose.prod.yml`: PostgreSQL и приложение доступны
только во внутренней Docker-сети, а наружу опубликованы только `80/443` через
Caddy. Сервис `migrate` должен успешно применить миграции до старта приложения.

```bash
cp .env.production.example .env.production
chmod 600 .env.production
# заполнить значения; пустой PRIVACY_POLICY_URL не оставлять
docker compose --env-file .env.production -f compose.prod.yml config --quiet
docker compose --env-file .env.production -f compose.prod.yml up -d --build
```

После появления валидного HTTPS и ручной проверки `/healthz` webhook и меню
команд регистрируются из уже собранного production-образа:

```bash
docker compose --env-file .env.production -f compose.prod.yml run --rm app \
  node dist/scripts/set-webhook.js
```

На первом сервере токен можно ввести без командной строки и shell history:

```bash
./deploy/set-token-and-webhook.sh
```

Скрипт отключает echo терминала, атомарно обновляет root-only `.env.production`,
перезапускает приложение, ждёт валидный HTTPS `/healthz` и только затем
регистрирует webhook. Сам токен не печатается.

Ключ Cloud.ru Foundation Models вводится тем же безопасным способом:

```bash
./deploy/set-llm-key.sh
```

Скрипт сначала проверяет ключ коротким запросом к Cloud.ru, затем атомарно
добавляет полный набор `LLM_*`, пересоздаёт приложение и ждёт внешний
`/healthz`. При ошибке запуска или healthcheck прежний environment
восстанавливается; ключ не попадает в argv или shell history.

Проверить `getWebhookInfo` и пройти `/start` нужно до приглашения тестировщиков.
При откате приложение останавливается тем же compose-файлом; volume `pgdata` не
удалять. Перед обновлениями с реальными пользователями делать `pg_dump`.
