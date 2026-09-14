import { z } from 'zod'

// Конфигурация читается один раз на старте и падает сразу, если чего-то нет.
// Бот, поднявшийся без токена, выглядит живым в логах и молчит в Telegram —
// это худший вид отказа, потому что мониторинг его не видит.
const schema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  TELEGRAM_WEBHOOK_SECRET: z.string().min(16),
  DATABASE_URL: z.string().min(1),
  PORT: z.coerce.number().default(3000),
})

export type Config = z.infer<typeof schema>

let cached: Config | null = null

export function config(): Config {
  if (cached) return cached
  const parsed = schema.safeParse(process.env)
  if (!parsed.success) {
    const missing = parsed.error.issues.map((i) => i.path.join('.')).join(', ')
    throw new Error(`Не заданы переменные окружения: ${missing}`)
  }
  cached = parsed.data
  return cached
}
