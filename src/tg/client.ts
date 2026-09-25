import { config } from '../lib/config.js'
import { z } from 'zod'

// Токен живёт только в URL запроса и нигде больше: ни в сообщениях ошибок, ни в
// логах. Сообщения TelegramError содержат описание от Telegram и не логируются
// (src/lib/log.ts берёт у ошибки только имя и код).
const endpoint = (method: string) => `https://api.telegram.org/bot${config().TELEGRAM_BOT_TOKEN}/${method}`

type TelegramResponse = {
  ok: boolean
  result?: unknown
  description?: string
  error_code?: number
  parameters?: { retry_after?: number }
}

export class TelegramError extends Error {
  override name = 'TelegramError'
  constructor(
    message: string,
    readonly code: number | null,
    readonly retryAfterSec: number | null = null,
  ) {
    super(message)
  }
}

// Сетевая ошибка с ответом на главный вопрос очереди: мог ли Telegram получить
// запрос. sent = false — соединение не установилось, запрос точно не ушёл, его
// можно повторить. sent = true — запрос ушёл, а ответа нет: доставлено ли,
// неизвестно, и повтор может дать дубль.
export class DeliveryError extends Error {
  override name = 'DeliveryError'
  constructor(
    readonly maybeSent: boolean,
    readonly code: string,
  ) {
    super(code)
  }
}

// Коды undici и Node, при которых соединение не состоялось и тело не ушло.
const NOT_SENT = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_CONNECT_TIMEOUT'])

const TIMEOUT_MS = 10_000

export async function call(method: string, body: Record<string, unknown>): Promise<unknown> {
  let res: Response
  try {
    res = await fetch(endpoint(method), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (error) {
    const cause = (error as { cause?: { code?: string } }).cause
    const code = cause?.code ?? (error as { name?: string }).name ?? 'unknown'
    throw new DeliveryError(!NOT_SENT.has(code), code)
  }
  let json: TelegramResponse
  try {
    json = (await res.json()) as TelegramResponse
  } catch {
    // Ответ пришёл, но не от Bot API (502 балансировщика и т. п.): что стало с
    // запросом, неизвестно.
    throw new DeliveryError(true, `http_${res.status}`)
  }
  // Код ошибки Telegram сохраняем: по нему отличается блокировка бота
  // пользователем (403) от временного сбоя, и дальше это определяет, ретраить
  // отправку или гасить пользователя в базе.
  if (!json.ok) {
    throw new TelegramError(`${method}: ${json.description ?? 'unknown error'}`, json.error_code ?? null, json.parameters?.retry_after ?? null)
  }
  return json.result
}

export type Button = { text: string; data: string }
export type Keyboard = Button[][]
export type ReplyKeyboard = string[][]

// То, чем бот пользуется из Telegram. Интерфейс, а не прямые вызовы: тесты
// подменяют его и видят каждое отправленное сообщение.
export interface Telegram {
  send(chatId: bigint, text: string, keyboard?: Keyboard, replyKeyboard?: ReplyKeyboard): Promise<void>
  answerCallback(callbackId: string, text?: string): Promise<void>
  clearKeyboard(chatId: bigint, messageId: number): Promise<void>
  download(fileId: string, maxBytes: number): Promise<Uint8Array>
}

export const telegram: Telegram = {
  async send(chatId, text, keyboard, replyKeyboard) {
    await call('sendMessage', {
      chat_id: chatId.toString(),
      text,
      link_preview_options: { is_disabled: true },
      ...(keyboard
        ? { reply_markup: { inline_keyboard: keyboard.map((row) => row.map((b) => ({ text: b.text, callback_data: b.data }))) } }
        : replyKeyboard
          ? {
              reply_markup: {
                keyboard: replyKeyboard.map((row) => row.map((text) => ({ text }))),
                resize_keyboard: true,
                is_persistent: true,
              },
            }
        : {}),
    })
  },
  async answerCallback(callbackId, text) {
    await call('answerCallbackQuery', { callback_query_id: callbackId, ...(text ? { text } : {}) })
  },
  async clearKeyboard(chatId, messageId) {
    await call('editMessageReplyMarkup', { chat_id: chatId.toString(), message_id: messageId, reply_markup: { inline_keyboard: [] } })
  },
  async download(fileId, maxBytes) {
    const parsed = z
      .object({ file_path: z.string().min(1), file_size: z.number().nonnegative().optional() })
      .safeParse(await call('getFile', { file_id: fileId }))
    if (!parsed.success || parsed.data.file_path.includes('..')) throw new TelegramError('getFile: invalid response', null)
    if (parsed.data.file_size !== undefined && parsed.data.file_size > maxBytes) {
      throw new TelegramError('getFile: file too large', 413)
    }

    let response: Response
    try {
      response = await fetch(`https://api.telegram.org/file/bot${config().TELEGRAM_BOT_TOKEN}/${parsed.data.file_path}`, {
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
    } catch {
      throw new DeliveryError(false, 'download_failed')
    }
    if (!response.ok || !response.body) throw new TelegramError(`download: HTTP ${response.status}`, response.status)

    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    while (true) {
      const part = await reader.read()
      if (part.done) break
      total += part.value.byteLength
      if (total > maxBytes) {
        await reader.cancel()
        throw new TelegramError('download: file too large', 413)
      }
      chunks.push(part.value)
    }
    const bytes = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    return bytes
  },
}
