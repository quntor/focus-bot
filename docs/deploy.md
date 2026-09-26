# Развёртывание

## Переменные окружения

Имена — в `.env.example`, значения в репозитории не хранятся. Приложение при старте
проверяет наличие и формат и падает с именем переменной, без значения.

Модель включается только полным набором `LLM_API_KEY`, `LLM_BASE_URL` и
`LLM_MODEL`. Если не задана ни одна из них, бот использует детерминированный
fallback. Значения API моделей Сбер 500 приведены в [llm.md](llm.md); защищённый
`SBER_API_TOKEN` записывается в `LLM_API_KEY` только в root-only
`.env.production`.

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

- Прогнать миграции: `npx prisma migrate deploy`.

## Production Compose

Production-контур описан в `compose.prod.yml`: PostgreSQL и приложение доступны
только во внутренней Docker-сети, а наружу опубликованы только `80/443` через
Caddy. Сервис `migrate` должен успешно применить миграции до старта приложения.

```bash
cp .env.production.example .env.production
chmod 600 .env.production
# заполнить значения
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

Токен API моделей Сбер 500 вводится тем же безопасным способом:

```bash
./deploy/set-llm-key.sh
```

Скрипт сначала проверяет токен через `/models` и короткий `chat/completions`,
затем атомарно добавляет полный набор `LLM_*` и `STT_MODEL`, пересоздаёт
приложение и ждёт внешний `/healthz`. При ошибке запуска или healthcheck прежний
environment восстанавливается; токен не попадает в argv или shell history.

Проверить `getWebhookInfo` и пройти `/start` нужно до приглашения тестировщиков.
При откате приложение останавливается тем же compose-файлом; volume `pgdata` не
удалять. Перед обновлениями с реальными пользователями делать `pg_dump`.

## Автоматическое обновление `main`

Production не принимает входящие команды от GitHub и не хранит GitHub token.
Root-owned systemd timer раз в две минуты запускает `deploy/auto-deploy.sh`:

1. читает точный SHA публичной ветки `main` через `git ls-remote`;
2. через публичный GitHub API требует успешный workflow `CI` именно для этого SHA;
3. скачивает HTTPS-архив exact commit, отклоняет небезопасные пути;
4. собирает новые images до переключения контейнеров;
5. создаёт mode-`600` backup БД, исходников и `.env.production` вне build context,
   затем атомарно меняет дерево и запускает migration/update без новой сборки;
6. ждёт container health и внешний `https://$DOMAIN/healthz = ok`, только затем
   записывает полный SHA в `.release-commit`.

При ошибке исходники и прежние image ID возвращаются на предыдущую версию без
обращения к registry; миграции поэтому обязаны быть обратно совместимыми минимум
с предыдущим релизом. Сетевые ошибки сборки повторяются трижды до переключения.
Хранятся пять последних комплектов backup. Новых публичных портов нет.
Базовый Node image берётся из публичного Google mirror и закреплён тем же digest,
что официальный `node:24-alpine`, чтобы VDS не зависел от Docker Hub rate-limit.

Первичная установка или восстановление таймера выполняется после проверенного
ручного релиза:

```bash
install -m 755 deploy/auto-deploy.sh /usr/local/sbin/focus-bot-auto-deploy
install -m 644 deploy/focus-bot-auto-deploy.{service,timer} /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now focus-bot-auto-deploy.timer
```

Без изменения production проверить решение `main` и CI можно безопасно:

```bash
FOCUS_DEPLOY_CHECK_ONLY=1 ./deploy/auto-deploy.sh
```
