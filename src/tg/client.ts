import { config } from '../lib/config.js'

const endpoint = (method: string) => `https://api.telegram.org/bot${config().TELEGRAM_BOT_TOKEN}/${method}`

type TelegramResponse = {
  ok: boolean
  result?: unknown
  description?: string
  error_code?: number
}

export class TelegramError extends Error {
  constructor(
    message: string,
    readonly code: number | null,
  ) {
    super(message)
    this.name = 'TelegramError'
  }
}

export async function call(method: string, body: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(endpoint(method), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const json = (await res.json()) as TelegramResponse
  // Код ошибки Telegram сохраняем: по нему отличается блокировка бота
  // пользователем (403) от временного сбоя, и дальше это определяет, ретраить
  // отправку или гасить пользователя в базе.
  if (!json.ok) throw new TelegramError(`${method}: ${json.description ?? 'unknown error'}`, json.error_code ?? null)
  return json.result
}

export async function sendMessage(chatId: number | bigint, text: string): Promise<void> {
  await call('sendMessage', {
    chat_id: typeof chatId === 'bigint' ? chatId.toString() : chatId,
    text,
    link_preview_options: { is_disabled: true },
  })
}
