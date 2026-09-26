import { z } from 'zod'

// Конфигурация читается один раз на старте и падает сразу, если чего-то нет.
// Бот, поднявшийся без токена, выглядит живым в логах и молчит в Telegram —
// это худший вид отказа, потому что мониторинг его не видит.

// Telegram принимает secret_token из A-Z, a-z, 0-9, _ и - длиной 1–256
// (Bot API, setWebhook). Нижнюю границу поднимаем до 32: секрет перебирают.
const token = z.string().regex(/^[A-Za-z0-9_-]{32,256}$/)

const optionalString = z.preprocess((value) => (value === '' ? undefined : value), z.string().min(1).optional())
const optionalHttpsUrl = z.preprocess(
  (value) => (value === '' ? undefined : value),
  z.string().url().refine((value) => value.startsWith('https://'), 'должен использовать https').optional(),
)
const schema = z
  .object({
    TELEGRAM_BOT_TOKEN: z.string().min(1),
    TELEGRAM_WEBHOOK_SECRET: token,
    // Отдельный непредсказуемый сегмент пути. Путь оседает в логах прокси и
    // балансировщика, поэтому он не совпадает с секретом из заголовка: утечка
    // пути не даёт права слать апдейты.
    TELEGRAM_WEBHOOK_PATH: token,
    DATABASE_URL: z.string().min(1),
    PORT: z.coerce.number().default(3000),
    // Модель включается только полным набором. Пустые значения из скопированного
    // .env.example считаются отсутствующими и сохраняют детерминированный режим.
    LLM_API_KEY: optionalString,
    LLM_BASE_URL: optionalHttpsUrl,
    LLM_MODEL: optionalString,
    // STT использует те же ключ и base URL, но включается отдельно: голос не
    // должен неожиданно стать платным только из-за включённой текстовой модели.
    STT_MODEL: optionalString,
  })
  .superRefine((value, ctx) => {
    const fields = ['LLM_API_KEY', 'LLM_BASE_URL', 'LLM_MODEL'] as const
    const configured = fields.filter((field) => value[field] !== undefined)
    if (configured.length !== 0 && configured.length !== fields.length) {
      for (const field of fields) {
        if (value[field] === undefined) ctx.addIssue({ code: 'custom', path: [field], message: 'нужен полный набор LLM_*' })
      }
    }
    if (value.STT_MODEL && (!value.LLM_API_KEY || !value.LLM_BASE_URL)) {
      ctx.addIssue({ code: 'custom', path: ['STT_MODEL'], message: 'для STT нужны LLM_API_KEY и LLM_BASE_URL' })
    }
  })

export type Config = z.infer<typeof schema>

let cached: Config | null = null

export function parseConfig(env: NodeJS.ProcessEnv): Config {
  const parsed = schema.safeParse(env)
  if (!parsed.success) {
    // Только имена переменных. zod кладёт в issue и полученное значение, а
    // значение секрета не должно оказаться ни в логе, ни в трейсбеке.
    const names = [...new Set(parsed.error.issues.map((i) => i.path.join('.')))].join(', ')
    throw new Error(`Не задана или задана неверно переменная окружения: ${names}`)
  }
  return parsed.data
}

export function config(): Config {
  if (cached) return cached
  cached = parseConfig(process.env)
  return cached
}
