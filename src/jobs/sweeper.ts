import { reconcile, freezeReminders, lockUser } from '../reminders/store.js'
import { logEvent, refreshRole } from '../analytics/log.js'
import { ACTIVE_WINDOW_MS, NEW_DAYS } from '../analytics/roles.js'
import { log } from '../lib/log.js'
import { cancelPending } from '../outbox/queue.js'
import { ensureNextMeeting } from '../bot/day-flow.js'
import { reply, type Ctx } from '../bot/context.js'
import { autoFinish } from '../bot/session-flow.js'
import { T } from '../bot/texts.js'
import { StaleTransition } from '../session/fsm.js'

const MIN = 60_000
// Незакрытая сессия через час после планового конца — брошена. Не висит вечно и
// не считается завершённой работой.
export const ABANDON_AFTER_MS = 60 * MIN
// Вопрос «с чего начнёшь» без ответа через час — отменён (не брошен).
export const EXPIRE_COLLECTING_MS = 60 * MIN
// Перерыв дольше трёх часов — забытый: сессия закрывается. Иначе «на
// перерыве» висело бы вечно, а встречи при идущей сессии не приходят.
export const EXPIRE_BREAK_MS = 3 * 60 * MIN

export async function sweepOnce(ctx: Ctx): Promise<void> {
  const now = ctx.now()
  if (ctx.remindersEnabled) await reconcile(ctx)
  else await freezeReminders(ctx)

  // Час без ответа после планового конца — сессия засчитывается до планового
  // конца, и бот говорит об этом. Раньше она молча бросалась, и честная работа
  // пропадала.
  const overdue = await ctx.db.focusSession.findMany({
    where: { reminderPolicy:0,state: 'running', plannedEndAt: { lt: new Date(now.getTime() - ABANDON_AFTER_MS) } },
    include: { user: true },
    take: 200,
  })
  for (const s of overdue) {
    let result: { elapsed: number; counted: boolean } | null = null
    try {
      result = await ctx.db.$transaction(async (tx) => {
        await lockUser(tx, s.userId)
        const current = await tx.focusSession.findFirst({ where: {
          id: s.id, userId: s.userId, reminderPolicy: 0, state: 'running',
          plannedEndAt: { lt: new Date(now.getTime() - ABANDON_AFTER_MS) },
        }, include: { user: true } })
        if (!current) return null
        const r = await autoFinish(tx, current.user, current, current.plannedEndAt!, now, 'timeout')
        if (r.counted) await tx.user.update({ where: { id: s.userId }, data: { pendingInput: 'report_text' } })
        else await tx.user.updateMany({ where: { id: s.userId, pendingInput: `session_end:${s.id}` }, data: { pendingInput: 'none' } })
        return r
      })
    } catch (error) {
      if (error instanceof StaleTransition) continue
      throw error
    }
    if (result && !s.user.blockedAt) await reply(ctx, s.user, T.autoFinished(result.elapsed, result.counted))
  }

  // Засчитывается работа до перерыва, дальше — следующая встреча, чтобы бот
  // не замолчал.
  const forgotten = await ctx.db.focusSession.findMany({
    where: { reminderPolicy:0,state: 'paused', pausedAt: { lt: new Date(now.getTime() - EXPIRE_BREAK_MS) } },
    include: { user: true },
    take: 200,
  })
  for (const s of forgotten) {
    let result: { elapsed: number; counted: boolean } | null = null
    try {
      result = await ctx.db.$transaction(async (tx) => {
        await lockUser(tx, s.userId)
        const current = await tx.focusSession.findFirst({ where: {
          id: s.id, userId: s.userId, reminderPolicy: 0, state: 'paused',
          pausedAt: { lt: new Date(now.getTime() - EXPIRE_BREAK_MS) },
        }, include: { user: true } })
        if (!current) return null
        const r = await autoFinish(tx, current.user, current, current.pausedAt!, now, 'break_timeout')
        await tx.user.updateMany({
          where: { id: s.userId, pendingInput: { in: [`session_end:${s.id}`, `running_work:${s.id}`, `running_duration:${s.id}`] } },
          data: { pendingInput: 'none' },
        })
        await ensureNextMeeting(tx, current.user, now)
        return r
      })
    } catch (error) {
      if (error instanceof StaleTransition) continue
      throw error
    }
    if (result && !s.user.blockedAt) await reply(ctx, s.user, T.breakExpired(result.elapsed, result.counted))
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

  // Страховка инварианта «всегда есть следующая встреча»: тем, у кого с
  // «писать первым» нет ни одного будущего сообщения и нет идущей сессии,
  // ставим утро. Знакомство не прошли — не трогаем.
  const silent = await ctx.db.user.findMany({
    where: {
      proactive: true,
      blockedAt: null,
      pendingInput: { notIn: ['timezone', 'start_time', 'ritual'] },
      outbox: { none: { status: 'pending', kind: { in: ['meeting', 'summary', 'rest_over'] } } },
      sessions: { none: { state: { in: ['collecting_intent', 'running', 'paused'] } } },
    },
    take: 200,
  })
  for (const u of silent) await ctx.db.$transaction((tx) => ensureNextMeeting(tx, u, now))

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
