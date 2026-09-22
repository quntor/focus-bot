import { z } from 'zod'

// Конфигурация читается один раз на старте и падает сразу, если чего-то нет.
// Бот, поднявшийся без токена, выглядит живым в логах и молчит в Telegram —
// это худший вид отказа, потому что мониторинг его не видит.

// Telegram принимает secret_token из A-Z, a-z, 0-9, _ и - длиной 1–256
// (Bot API, setWebhook). Нижнюю границу поднимаем до 32: секрет перебирают.
const token = z.string().regex(/^[A-Za-z0-9_-]{32,256}$/)

const schema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  TELEGRAM_WEBHOOK_SECRET: token,
  // Отдельный непредсказуемый сегмент пути. Путь оседает в логах прокси и
  // балансировщика, поэтому он не совпадает с секретом из заголовка: утечка
  // пути не даёт права слать апдейты.
  TELEGRAM_WEBHOOK_PATH: token,
  DATABASE_URL: z.string().min(1),
  PORT: z.coerce.number().default(3000),
  // Ссылка на политику обработки персональных данных, показывается при
  // согласии. Необязательна в разработке, в бою без неё согласие неполное.
  PRIVACY_POLICY_URL: z.string().url().optional(),
})

export type Config = z.infer<typeof schema>

let cached: Config | null = null

export function config(): Config {
  if (cached) return cached
  const parsed = schema.safeParse(process.env)
  if (!parsed.success) {
    // Только имена переменных. zod кладёт в issue и полученное значение, а
    // значение секрета не должно оказаться ни в логе, ни в трейсбеке.
    const names = [...new Set(parsed.error.issues.map((i) => i.path.join('.')))].join(', ')
    throw new Error(`Не задана или задана неверно переменная окружения: ${names}`)
  }
  cached = parsed.data
  return cached
}
