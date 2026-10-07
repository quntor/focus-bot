import type { Ctx } from '../bot/context.js'
import type { LlmProvider } from '../llm/provider.js'
import { disabledProvider } from '../llm/provider.js'
import type { SttProvider } from '../stt/provider.js'
import { disabledSttProvider } from '../stt/provider.js'
import type { Keyboard, ReplyKeyboard, Telegram } from '../tg/client.js'
import { handleUpdate } from '../tg/webhook.js'
import { prisma } from './db.js'
import * as account from '../bot/account.js'

export type Sent = { chatId: bigint; text: string; keyboard?: Keyboard | undefined; replyKeyboard?: ReplyKeyboard | undefined }

// Поддельный Telegram: запоминает каждое сообщение. Тесты читают отсюда, что
// именно увидел пользователь — вплоть до байта.
export function fakeTelegram(): Telegram & {
  sent: Sent[]
  failNext: unknown[]
  downloads: Map<string, Uint8Array>
  downloadRequests: string[]
} {
  const sent: Sent[] = []
  const failNext: unknown[] = []
  const downloads = new Map<string, Uint8Array>()
  const downloadRequests: string[] = []
  return {
    sent,
    failNext,
    downloads,
    downloadRequests,
    async send(chatId, text, keyboard, replyKeyboard) {
      const error = failNext.shift()
      if (error) throw error
      sent.push({ chatId, text, keyboard, replyKeyboard })
    },
    async answerCallback() {},
    async clearKeyboard() {},
    async download(fileId, maxBytes) {
      downloadRequests.push(fileId)
      const bytes = downloads.get(fileId)
      if (!bytes) throw new Error('missing test download')
      if (bytes.byteLength > maxBytes) throw new Error('download too large')
      return bytes
    },
  }
}

// Общий на все боты теста: update_id уникален глобально, как у Telegram, и
// processed_updates не должен отбрасывать апдейты второго бота как дубли первого.
let updateId = 1

export function makeBot(opts: { now?: Date; llm?: LlmProvider; stt?: SttProvider; semanticRouterEnabled?: boolean } = {}) {
  let now = opts.now ?? new Date('2026-09-22T07:00:00Z')
  const tg = fakeTelegram()
  const ctx: Ctx = {
    db: prisma,
    semanticRouterEnabled: opts.semanticRouterEnabled ?? false,
    tg,
    llm: opts.llm ?? disabledProvider,
    stt: opts.stt ?? disabledSttProvider,
    now: () => now,
  }

  const text = (tgId: number, t: string, id = updateId++) =>
    handleUpdate(ctx, { update_id: id, message: { text: t, from: { id: tgId }, chat: { id: tgId, type: 'private' } } })
  const press = (tgId: number, data: string, id = updateId++) =>
    handleUpdate(ctx, {
      update_id: id,
      callback_query: { id: `cq${id}`, from: { id: tgId }, data, message: { message_id: 1, chat: { id: tgId, type: 'private' } } },
    })
  const voice = (
    tgId: number,
    input: { fileId: string; duration: number; mimeType?: string; fileSize?: number },
    id = updateId++,
  ) =>
    handleUpdate(ctx, {
      update_id: id,
      message: {
        voice: {
          file_id: input.fileId,
          duration: input.duration,
          ...(input.mimeType ? { mime_type: input.mimeType } : {}),
          ...(input.fileSize !== undefined ? { file_size: input.fileSize } : {}),
        },
        from: { id: tgId },
        chat: { id: tgId, type: 'private' },
      },
    })

  // Explicit model result, never an interpreter for test inputs.
  async function textAs(tgId: number, input: string, response: object, id?: number) {
    const previous = ctx.llm
    ctx.llm = { enabled: true, model: 'explicit-test', async complete(request) {
      if (JSON.parse(request.input).text !== input) throw new Error('unexpected model input')
      return { text: JSON.stringify(response), usage: null }
    } }
    try { await text(tgId, input, id) } finally { ctx.llm = previous }
  }

  // Все кнопки, показанные пользователю, — чтобы нажимать «как человек».
  const buttons = (tgId: number) =>
    tg.sent.filter((s) => s.chatId === BigInt(tgId)).flatMap((s) => s.keyboard?.flat() ?? [])
  const lastButton = (tgId: number, prefix: string, suffix = '') => {
    const found = buttons(tgId).filter((b) => b.data.startsWith(prefix) && b.data.endsWith(suffix)).at(-1)
    if (!found) throw new Error(`нет кнопки ${prefix}`)
    return found.data
  }
  const lastText = (tgId: number) => tg.sent.filter((s) => s.chatId === BigInt(tgId)).at(-1)?.text ?? ''
  const textsTo = (tgId: number) => tg.sent.filter((s) => s.chatId === BigInt(tgId)).map((s) => s.text)

  // Backend fixtures are not evidence that the LLM understood onboarding.
  // Real onboarding ingress is tested separately with explicit model responses.
  async function setupOnboarded(tgId: number, localTime = '10:00') {
    const user = await prisma.user.upsert({ where: { tgId: BigInt(tgId) }, create: { tgId: BigInt(tgId), createdAt: now }, update: {} })
    const setup = { ...ctx, inputUserId: user.id, semanticRouterEnabled: true }
    await account.beginOnboarding(setup, user)
    await account.onTimezoneText(setup, { ...user, pendingInput: 'timezone' }, localTime)
    await account.onOnboardingButton(setup, await prisma.user.findUniqueOrThrow({ where: { id: user.id } }), 'st_skip')
    await account.onRitualText(setup, await prisma.user.findUniqueOrThrow({ where: { id: user.id } }), null)
  }

  return {
    ctx,
    tg,
    text,
    textAs,
    press,
    voice,
    buttons,
    lastButton,
    lastText,
    textsTo,
    setupOnboarded,
    advance: (minutes: number) => {
      now = new Date(now.getTime() + minutes * 60_000)
    },
    setNow: (d: Date) => {
      now = d
    },
    now: () => now,
  }
}
