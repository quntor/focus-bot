import { logEvent, refreshRole } from '../analytics/log.js'
import { ACTIVE_WINDOW_MS, NEW_DAYS } from '../analytics/roles.js'
import { log } from '../lib/log.js'
import type { Ctx } from '../bot/context.js'
import { cancelPending } from '../outbox/queue.js'

const MIN = 60_000
// Незакрытая сессия через час после планового конца — брошена. Не висит вечно и
// не считается завершённой работой.
export const ABANDON_AFTER_MS = 60 * MIN
// Вопрос «с чего начнёшь» без ответа через час — отменён (не брошен).
export const EXPIRE_COLLECTING_MS = 60 * MIN

export async function sweepOnce(ctx: Ctx): Promise<void> {
  const now = ctx.now()

  const overdue = await ctx.db.focusSession.findMany({
    where: { state: 'running', plannedEndAt: { lt: new Date(now.getTime() - ABANDON_AFTER_MS) } },
    select: { id: true, userId: true },
    take: 200,
  })
  for (const s of overdue) {
    await ctx.db.$transaction(async (tx) => {
      const res = await tx.focusSession.updateMany({
        where: { id: s.id, userId: s.userId, state: 'running' },
        data: { state: 'abandoned', abandonReason: 'timeout', finishedAt: now },
      })
      if (res.count !== 1) return
      await cancelPending(tx, { userId: s.userId, idempotencyKey: { startsWith: `ping:${s.id}` } })
      await logEvent(tx, s.userId, 'session_abandoned', { session_id: s.id, reason: 'timeout' }, { at: now, sessionId: s.id })
    })
  }

  const stale = await ctx.db.focusSession.findMany({
    where: { state: 'collecting_intent', createdAt: { lt: new Date(now.getTime() - EXPIRE_COLLECTING_MS) } },
    select: { id: true, userId: true },
    take: 200,
  })
  for (const s of stale) {
    await ctx.db.$transaction(async (tx) => {
      const res = await tx.focusSession.updateMany({
        where: { id: s.id, userId: s.userId, state: 'collecting_intent' },
        data: { state: 'cancelled', finishedAt: now },
      })
      if (res.count === 1) await logEvent(tx, s.userId, 'session_expired', {}, { at: now, sessionId: s.id })
    })
  }

  // Роли меняются и без событий: уснувшего никто не будит.
  const candidates = await ctx.db.user.findMany({
    where: {
      OR: [
        { role: { in: ['active', 'observer'] }, lastUserActionAt: { lt: new Date(now.getTime() - ACTIVE_WINDOW_MS) } },
        { role: 'new', createdAt: { lt: new Date(now.getTime() - NEW_DAYS * 86_400_000) } },
      ],
    },
    select: { id: true },
    take: 200,
  })
  for (const u of candidates) await ctx.db.$transaction((tx) => refreshRole(tx, u.id, now))

  // Дубли апдейтов приходят в пределах минут; неделя — с большим запасом.
  await ctx.db.processedUpdate.deleteMany({ where: { receivedAt: { lt: new Date(now.getTime() - 7 * 86_400_000) } } })
  await ctx.db.rateLimit.deleteMany({ where: { windowStart: { lt: new Date(now.getTime() - 10 * MIN) } } })
}

// Фоновые циклы. Оба идемпотентны и безопасны при нескольких процессах: очередь
// берётся под SKIP LOCKED, переходы — условным UPDATE.
export function startLoops(ctx: Ctx, run: { outbox: () => Promise<number> }): () => void {
  let stopped = false
  const loop = async (name: string, fn: () => Promise<unknown>, everyMs: number) => {
    while (!stopped) {
      try {
        await fn()
      } catch (error) {
        log.error(`${name}_failed`, error)
      }
      await new Promise((r) => setTimeout(r, everyMs))
    }
  }
  void loop('outbox', run.outbox, 2_000)
  void loop('sweeper', () => sweepOnce(ctx), 60_000)
  return () => {
    stopped = true
  }
}
