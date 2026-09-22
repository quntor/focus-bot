import type { PrismaClient, User } from '@prisma/client'
import type { LlmProvider } from '../llm/provider.js'
import type { Keyboard, Telegram } from '../tg/client.js'
import { TelegramError } from '../tg/client.js'
import { log } from '../lib/log.js'
import { logEvent } from '../analytics/log.js'
import { cancelPending } from '../outbox/queue.js'

// Всё, от чего зависит обработка: база, Telegram, модель и часы. Часы — тоже
// зависимость: источник истины по времени — сервер, а тесты двигают время сами.
export type Ctx = {
  db: PrismaClient
  tg: Telegram
  llm: LlmProvider
  now: () => Date
  policyUrl?: string | undefined
}

// Бот заблокирован пользователем (403): помечаем и прекращаем отправку, а не
// долбим очередь ретраями.
export async function markBlocked(ctx: Ctx, userId: string): Promise<void> {
  await ctx.db.$transaction(async (tx) => {
    const res = await tx.user.updateMany({ where: { id: userId, blockedAt: null }, data: { blockedAt: ctx.now() } })
    if (res.count === 0) return
    await cancelPending(tx, { userId })
    await logEvent(tx, userId, 'user_blocked', {}, { at: ctx.now() })
  })
}

// Ответ пользователю в потоке обработки апдейта. Состояние к этому моменту уже
// записано, поэтому ошибка отправки не откатывает его и наружу не летит.
export async function reply(ctx: Ctx, user: Pick<User, 'id' | 'tgId'>, text: string, keyboard?: Keyboard): Promise<void> {
  try {
    await ctx.tg.send(user.tgId, text, keyboard)
  } catch (error) {
    if (error instanceof TelegramError && error.code === 403) {
      await markBlocked(ctx, user.id)
      return
    }
    log.error('reply_failed', error)
  }
}
