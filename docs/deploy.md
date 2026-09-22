# Развёртывание

## Переменные окружения

Имена — в `.env.example`, значения в репозитории не хранятся. Приложение при старте
проверяет наличие и формат и падает с именем переменной, без значения.

`TELEGRAM_WEBHOOK_SECRET` и `TELEGRAM_WEBHOOK_PATH` — две разные случайные строки
из `A-Z a-z 0-9 _ -` длиной 32–256 символов. Например:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

Регистрация вебхука — `npm run set-webhook` (нужен `PUBLIC_URL` с https). Telegram
принимает вебхуки только на портах 443, 80, 88 и 8443.

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
