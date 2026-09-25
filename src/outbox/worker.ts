import type { OutboxMessage, Prisma, User } from '@prisma/client'
import { logEvent } from '../analytics/log.js'
import { dayKey } from '../lib/day.js'
import { log } from '../lib/log.js'
import { cb } from '../bot/callbacks.js'
import { markBlocked, type Ctx } from '../bot/context.js'
import { buildSummary, declineKeyboard, DECLINES_BEFORE_ASK, goalKeyboard, putDefaultMeeting, reminderKeyboard } from '../bot/day-flow.js'
import { openCollecting, outcomeKeyboard } from '../bot/session-flow.js'
import { T } from '../bot/texts.js'
import { DeliveryError, TelegramError, type Keyboard } from '../tg/client.js'
import { enqueue } from './queue.js'
import { OUTBOX_KINDS } from '../analytics/payloads.js'

const MIN = 60_000
// Аренда строки на время отправки. Если процесс умер с арендой на руках, строка
// становится uncertain, а не pending: запрос мог дойти до Telegram.
const LEASE_MS = 60_000
const BATCH = 20
const MAX_ATTEMPTS = 5

type Rendered = {
  text: string
  keyboard?: Keyboard
  // Что записать после успешной отправки — в одной транзакции с отметкой sent.
  after?: (tx: Prisma.TransactionClient) => Promise<void>
}
type Render = Rendered | { skip: true } | { replace: Rendered }

const payloadOf = (m: OutboxMessage) => (m.payload ?? {}) as Record<string, unknown>

// Взять пачку: SELECT ... FOR UPDATE SKIP LOCKED в одном UPDATE. Два воркера
// (две выкатки при деплое) не возьмут одну строку.
async function claim(ctx: Ctx): Promise<OutboxMessage[]> {
  const now = ctx.now()
  const until = new Date(now.getTime() + LEASE_MS)
  const ids = await ctx.db.$queryRaw<{ id: string }[]>`
    UPDATE outbox_messages SET status = 'sending', locked_until = ${until}, attempts = attempts + 1
    WHERE id IN (
      SELECT id FROM outbox_messages
      WHERE status = 'pending' AND send_after <= ${now}
      ORDER BY send_after
      LIMIT ${BATCH}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id`
  if (ids.length === 0) return []
  return ctx.db.outboxMessage.findMany({ where: { id: { in: ids.map((r) => r.id) } }, orderBy: { sendAfter: 'asc' } })
}

// Молчание на прошлое напоминание — тоже отказ. Считаем его в момент следующего.
async function countSilentDecline(ctx: Ctx, user: User): Promise<number> {
  const last = await ctx.db.outboxMessage.findFirst({
    where: { userId: user.id, kind: { in: ['meeting', 'rest_over'] }, status: 'sent' },
    orderBy: { sentAt: 'desc' },
  })
  if (!last?.sentAt) return user.declinesInRow
  if (user.lastUserActionAt && user.lastUserActionAt > last.sentAt) return user.declinesInRow
  const updated = await ctx.db.user.update({ where: { id: user.id }, data: { declinesInRow: { increment: 1 } } })
  return updated.declinesInRow
}

async function renderReminder(ctx: Ctx, user: User, text: string, keyboard: Keyboard, openSession: boolean): Promise<Render> {
  const declines = await countSilentDecline(ctx, user)
  if (declines >= DECLINES_BEFORE_ASK) {
    return {
      replace: {
        text: T.declineCheck,
        keyboard: declineKeyboard(),
        after: async (tx) => {
          await tx.user.update({ where: { id: user.id }, data: { declinesInRow: 0 } })
          await logEvent(tx, user.id, 'decline_check_sent', { declines_in_row: declines }, { at: ctx.now() })
        },
      },
    }
  }
  return {
    text,
    keyboard,
    after: async () => {
      // Вопрос «с чего начнёшь» открывает сессию, чтобы ответ текстом лёг в неё.
      if (openSession) await openCollecting(ctx, user.id)
    },
  }
}

async function render(ctx: Ctx, m: OutboxMessage, user: User): Promise<Render> {
  const p = payloadOf(m)
  const now = ctx.now()

  if (m.kind === 'ping' || m.kind === 'session_end') {
    const sessionId = String(p.sessionId ?? '')
    const session = await ctx.db.focusSession.findFirst({ where: { id: sessionId, userId: user.id } })
    // Устаревшее сообщение к закрытой сессии не уходит.
    if (!session || session.state !== 'running') return { skip: true }

    if (m.kind === 'session_end') {
      return {
        text: T.sessionEnd,
        keyboard: outcomeKeyboard(sessionId),
        after: (tx) => logEvent(tx, user.id, 'session_end_sent', { session_id: sessionId }, { at: now, sessionId }),
      }
    }

    // Пользователь мог отключить проверки, когда сообщение уже было взято
    // воркером из очереди. Повторно проверяем настройку непосредственно перед
    // отправкой, а pingAt сбрасывается обработчиком настройки.
    if (!user.pingsEnabled || !session.pingAt) return { skip: true }

    const n = Number(p.n ?? 1)
    const free = session.plannedMinutes === null
    if (free && n > 1 && session.pingAnsweredAt === null) {
      // Свободный режим: два неотвеченных пинга подряд — сессия брошена.
      const missed = session.pingsMissed + 1
      if (missed >= 2) {
        await ctx.db.$transaction(async (tx) => {
          const res = await tx.focusSession.updateMany({
            where: { id: sessionId, userId: user.id, state: 'running' },
            data: { state: 'abandoned', abandonReason: 'no_ping', finishedAt: now, pingsMissed: missed },
          })
          if (res.count === 1) await logEvent(tx, user.id, 'session_abandoned', { session_id: sessionId, reason: 'no_ping' }, { at: now, sessionId })
        })
        return { skip: true }
      }
      await ctx.db.focusSession.update({ where: { id: sessionId }, data: { pingsMissed: missed } })
    }
    return {
      text: T.ping,
      keyboard: [[{ text: T.pingHere, data: cb('ping', sessionId, 'here') }, { text: T.pingBack, data: cb('ping', sessionId, 'back') }]],
      after: async (tx) => {
        await tx.focusSession.updateMany({ where: { id: sessionId, userId: user.id }, data: { pingAt: now, pingAnsweredAt: null } })
        await logEvent(tx, user.id, 'ping_sent', { session_id: sessionId }, { at: now, sessionId })
        if (free) {
          await enqueue(tx, { userId: user.id, kind: 'ping', key: `ping:${sessionId}:${n + 1}`, sendAfter: new Date(now.getTime() + 30 * MIN), payload: { sessionId, n: n + 1 } })
        }
      },
    }
  }

  if (m.kind === 'rest_over') {
    const sessionId = String(p.sessionId ?? '')
    const session = await ctx.db.focusSession.findFirst({ where: { id: sessionId, userId: user.id } })
    if (!session || (session.restChoice !== null && session.restChoice !== 'rest')) return { skip: true }
    const active = await ctx.db.focusSession.count({ where: { userId: user.id, state: { in: ['running', 'paused'] } } })
    if (active > 0) return { skip: true }
    const r = await renderReminder(ctx, user, T.restOver, reminderKeyboard(), true)
    return withEvent(r, (tx) => logEvent(tx, user.id, 'rest_over_sent', { session_id: sessionId }, { at: now, sessionId }))
  }

  if (m.kind === 'meeting') {
    if (p.defaulted === true && !user.proactive) return { skip: true }
    const active = await ctx.db.focusSession.count({ where: { userId: user.id, state: { in: ['running', 'paused'] } } })
    if (active > 0) return { skip: true }
    const today = dayKey(now, user.timezone)
    const goal = await ctx.db.dailyGoal.findUnique({ where: { userId_dayKey: { userId: user.id, dayKey: today } } })
    const askGoal = p.morning === true && (goal?.targetSessions ?? null) === null
    // Понедельник — новый старт недели, и это стоит сказать.
    const monday = new Date(`${today}T00:00:00Z`).getUTCDay() === 1
    const r = askGoal
      ? await renderReminder(ctx, user, monday ? T.meetingMonday : T.meetingMorning, goalKeyboard(), false)
      : await renderReminder(ctx, user, T.meetingPlain, reminderKeyboard(), true)
    return withEvent(r, async (tx) => {
      await logEvent(tx, user.id, 'meeting_sent', {}, { at: now })
      if (p.defaulted === true) await logEvent(tx, user.id, 'meeting_defaulted', { minutes_ahead: 0 }, { at: now })
    })
  }

  if (m.kind === 'summary') {
    const day = String(p.dayKey ?? '')
    if (!user.proactive) return { skip: true }
    const goal = await ctx.db.dailyGoal.findUnique({ where: { userId_dayKey: { userId: user.id, dayKey: day } } })
    if (goal?.summarySentAt) return { skip: true }
    const summary = await buildSummary(ctx.db, user, day)
    return {
      text: T.summary(summary),
      keyboard: [[{ text: T.closeDay, data: cb('sum', null, day.replace(/-/g, '')) }]],
      after: async (tx) => {
        await tx.dailyGoal.upsert({
          where: { userId_dayKey: { userId: user.id, dayKey: day } },
          create: { userId: user.id, dayKey: day, summarySentAt: now },
          update: { summarySentAt: now },
        })
        await logEvent(tx, user.id, 'daily_summary_sent', { day_key: day }, { at: now })
        // Сводка тоже не заканчивается тишиной: встреча на утро ставится сразу.
        const pending = await tx.outboxMessage.count({ where: { userId: user.id, kind: 'meeting', status: 'pending' } })
        if (pending === 0) await putDefaultMeeting(tx, user, now)
      },
    }
  }

  return { skip: true }
}

function withEvent(r: Render, extra: (tx: Prisma.TransactionClient) => Promise<void>): Render {
  if ('skip' in r) return r
  const target = 'replace' in r ? r.replace : r
  const prev = target.after
  target.after = async (tx) => {
    await prev?.(tx)
    await extra(tx)
  }
  return r
}

async function finish(ctx: Ctx, id: string, data: Prisma.OutboxMessageUpdateInput): Promise<void> {
  await ctx.db.outboxMessage.update({ where: { id }, data: { lockedUntil: null, ...data } })
}

async function deliver(ctx: Ctx, m: OutboxMessage): Promise<void> {
  const user = await ctx.db.user.findUnique({ where: { id: m.userId } })
  if (!user || user.blockedAt) return finish(ctx, m.id, { status: 'skipped' })

  let rendered: Render
  try {
    rendered = await render(ctx, m, user)
  } catch (error) {
    log.error('outbox_render_failed', error, { kind: m.kind })
    return finish(ctx, m.id, { status: 'failed', lastError: 'render' })
  }
  if ('skip' in rendered) return finish(ctx, m.id, { status: 'skipped' })
  const msg = 'replace' in rendered ? rendered.replace : rendered

  try {
    await ctx.tg.send(user.tgId, msg.text, msg.keyboard)
  } catch (error) {
    return onSendError(ctx, m, error)
  }

  // Отметка об отправке и всё, что из неё следует, — одной транзакцией.
  await ctx.db.$transaction(async (tx) => {
    await tx.outboxMessage.update({ where: { id: m.id }, data: { status: 'sent', sentAt: ctx.now(), lockedUntil: null } })
    await msg.after?.(tx)
  })
}

// Классификация ошибок. Повторяем только то, что точно не ушло в Telegram:
// дубль сообщения хуже потерянного, а ключа идемпотентности у sendMessage нет.
async function onSendError(ctx: Ctx, m: OutboxMessage, error: unknown): Promise<void> {
  const now = ctx.now()
  if (error instanceof TelegramError) {
    if (error.code === 403) {
      await finish(ctx, m.id, { status: 'failed', lastError: '403' })
      return markBlocked(ctx, m.userId)
    }
    if (error.code === 429) {
      const wait = (error.retryAfterSec ?? 30) * 1000
      return finish(ctx, m.id, { status: 'pending', sendAfter: new Date(now.getTime() + wait), lastError: '429' })
    }
    return finish(ctx, m.id, { status: 'failed', lastError: String(error.code ?? 'telegram') })
  }
  if (error instanceof DeliveryError && !error.maybeSent) {
    if (m.attempts >= MAX_ATTEMPTS) return finish(ctx, m.id, { status: 'failed', lastError: error.code })
    return finish(ctx, m.id, { status: 'pending', sendAfter: new Date(now.getTime() + 30_000 * m.attempts), lastError: error.code })
  }
  // Запрос ушёл, ответа нет. Не переотправляем, но записываем, чтобы потери
  // было видно в дашборде.
  await markUncertain(ctx, m, error instanceof DeliveryError ? error.code : 'unknown')
}

async function markUncertain(ctx: Ctx, m: OutboxMessage, code: string): Promise<void> {
  await ctx.db.$transaction(async (tx) => {
    const res = await tx.outboxMessage.updateMany({
      where: { id: m.id, status: 'sending' },
      data: { status: 'uncertain', lockedUntil: null, lastError: code.slice(0, 40) },
    })
    if (res.count === 1) {
      const kind = OUTBOX_KINDS.find((k) => k === m.kind)
      if (kind) await logEvent(tx, m.userId, 'outbox_uncertain', { kind, outbox_id: m.id }, { at: ctx.now() })
    }
  })
}

// Строки, которые процесс взял и не вернул (упал посреди отправки). Сообщение
// могло уйти — повторять нельзя.
export async function recoverStuck(ctx: Ctx): Promise<void> {
  const stuck = await ctx.db.outboxMessage.findMany({
    where: { status: 'sending', lockedUntil: { lt: ctx.now() } },
    take: BATCH,
  })
  for (const m of stuck) await markUncertain(ctx, m, 'lease_expired')
}

export async function runOutboxOnce(ctx: Ctx): Promise<number> {
  await recoverStuck(ctx)
  const batch = await claim(ctx)
  for (const m of batch) {
    try {
      await deliver(ctx, m)
    } catch (error) {
      // Ошибка после отправки (например, при записи отметки): статус остаётся
      // sending, и через аренду строка станет uncertain — не дубль.
      log.error('outbox_deliver_failed', error, { kind: m.kind })
    }
  }
  return batch.length
}
