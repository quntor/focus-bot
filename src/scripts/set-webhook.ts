// Регистрация вебхука: npm run set-webhook. Запускает человек, не приложение.
//
// secret_token — тот же, что сверяется в заголовке на каждом запросе. Адрес и
// секрет не печатаются: путь вебхука — тоже секрет, хоть и слабее заголовка.
// allowed_updates — только то, что бот разбирает: лишние типы апдейтов — лишняя
// поверхность и лишние обращения к базе.
import { call } from '../tg/client.js'
import { config } from '../lib/config.js'

const cfg = config()
const base = process.env.PUBLIC_URL
if (!base || !/^https:\/\//.test(base)) {
  console.error('Не задана или задана неверно переменная окружения: PUBLIC_URL (нужен https://)')
  process.exit(1)
}

await call('setWebhook', {
  url: `${base.replace(/\/$/, '')}/tg/${cfg.TELEGRAM_WEBHOOK_PATH}`,
  secret_token: cfg.TELEGRAM_WEBHOOK_SECRET,
  allowed_updates: ['message', 'callback_query'],
})
console.log('вебхук установлен')
