import { randomUUID } from 'node:crypto'
import type { OutboxMessage, Prisma, User } from '@prisma/client'
import { logEvent } from '../analytics/log.js'
import { log } from '../lib/log.js'
import { localHour } from '../lib/time.js'
import { cb } from '../bot/callbacks.js'
import { type Ctx } from '../bot/context.js'
import { rememberConversationContext, rememberQuestion } from '../bot/conversation-context.js'
import { hasDecision, morningResolved } from '../bot/message-policy.js'
import { buildSummary, declineKeyboard, DECLINES_BEFORE_ASK, ensureNextMeeting, reminderKeyboard } from '../bot/day-flow.js'
import { autoFinish, deadlineKeyboard } from '../bot/session-flow.js'
import { buildTaskStartPrompt } from '../bot/tasks.js'
import { rememberTaskNumberPrompt } from '../bot/task-number-prompt.js'
import { T } from '../bot/texts.js'
import { DeliveryError, TelegramError, type Keyboard } from '../tg/client.js'
import { enqueue } from './queue.js'
import { OUTBOX_KINDS } from '../analytics/payloads.js'
import { deliverReminder, recoverReminder } from '../reminders/delivery.js'
import { allowedAt, summaryAllowedAt } from '../reminders/cadence.js'
import { workDayKey } from '../lib/day.js'
import { lockUser } from '../reminders/store.js'

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

// Claim only the immediately deliverable row, not leases for a waiting batch.
// SELECT ... FOR UPDATE SKIP LOCKED in one UPDATE. Two workers
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
      LIMIT 1
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
  // Одно молчание — один отказ, даже если это напоминание собирается повторно.
  return ctx.db.$transaction(async (tx) => {
    const marked = await tx.outboxMessage.updateMany({ where: { id: last.id, silenceCountedAt: null }, data: { silenceCountedAt: ctx.now() } })
    if (marked.count !== 1) return user.declinesInRow
    const updated = await tx.user.update({ where: { id: user.id }, data: { declinesInRow: { increment: 1 } } })
    return updated.declinesInRow
  })
}

async function renderReminder(ctx: Ctx, user: User, text: string, keyboard: Keyboard): Promise<Render> {
  const declines = await countSilentDecline(ctx, user)
  if (declines >= DECLINES_BEFORE_ASK) {
    return {
      replace: {
        text: T.declineCheck,
        keyboard: declineKeyboard(),
        after: async (tx) => {
          await tx.user.update({ where: { id: user.id }, data: { declinesInRow: 0 } })
          await logEvent(tx, user.id, 'decline_check_sent', { declines_in_row: declines }, { at: ctx.now() })
          await ensureNextMeeting(tx, user, ctx.now())
        },
      },
    }
  }
  return {
    text,
    keyboard,
    // An invitation is not confirmed intent. It must not create a session
    // or capture the next unrelated reply as a task.
  }
}

async function render(ctx: Ctx, m: OutboxMessage, user: User, ownerTx?: Prisma.TransactionClient): Promise<Render> {
  const p = payloadOf(m)
  const now = ctx.now()

  if (m.kind === 'ping' || m.kind === 'session_end') {
    const sessionId = String(p.sessionId ?? '')
    const db = ownerTx ?? ctx.db
    const session = await db.focusSession.findFirst({ where: { id: sessionId, userId: user.id } })
    // Устаревшее сообщение к закрытой сессии не уходит.
    if (!session || session.state !== 'running') return { skip: true }

    if (m.kind === 'session_end') {
      return {
        text: T.sessionEnd,
        keyboard: deadlineKeyboard(sessionId),
        after: async (tx) => {
          // «Время вышло» — самый свежий вопрос: старое ожидание («Как назвать
          // задачу?» и т. п.) снимается, и ответ текстом идёт сюда. Знакомство
          // не прерываем.
          await tx.user.updateMany({
            where: { id: user.id, pendingInput: { notIn: ['timezone', 'start_time', 'ritual'] } },
            data: { pendingInput: `session_end:${sessionId}` },
          })
          await logEvent(tx, user.id, 'session_end_sent', { session_id: sessionId }, { at: now, sessionId })
        },
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
        // Засчитываем время до первой пропущенной проверки и говорим об этом.
        const finishFree = async (tx: Prisma.TransactionClient) => {
          await tx.focusSession.update({ where: { id: sessionId }, data: { pingsMissed: missed } })
          return autoFinish(tx, user, { ...session, pingsMissed: missed }, session.pingAt ?? now, now, 'no_ping')
        }
        const r = ownerTx ? await finishFree(ownerTx) : await ctx.db.$transaction(finishFree)
        return {
          text: T.autoFinished(r.elapsed, r.counted),
          after: async (tx) => {
            if (r.counted) await tx.user.update({ where: { id: user.id }, data: { pendingInput: 'report_text' } })
          },
        }
      }
      await db.focusSession.update({ where: { id: sessionId }, data: { pingsMissed: missed } })
    }
    return {
      text: T.ping,
      keyboard: [[{ text: T.pingHere, data: cb('ping', sessionId, 'here') }, { text: T.pingBack, data: cb('ping', sessionId, 'back') }]],
      after: async (tx) => {
        await tx.focusSession.updateMany({ where: { id: sessionId, userId: user.id }, data: { pingAt: now, pingAnsweredAt: null } })
        await logEvent(tx, user.id, 'ping_sent', { session_id: sessionId }, { at: now, sessionId })
        if (free) {
          const series = typeof p.series === 'string' ? p.series : null
          await enqueue(tx, {
            userId: user.id,
            kind: 'ping',
            key: series ? `ping:${sessionId}:${series}:${n + 1}` : `ping:${sessionId}:${n + 1}`,
            sendAfter: new Date(now.getTime() + 30 * MIN),
            payload: { sessionId, n: n + 1, ...(series ? { series } : {}) },
          })
        }
      },
    }
  }

  if (m.kind === 'rest_over') {
    const sessionId = String(p.sessionId ?? '')
    const session = await ctx.db.focusSession.findFirst({ where: { id: sessionId, userId: user.id } })
    if (!session || session.restChoice !== 'rest' || user.idleRestAt) return { skip: true }
    const active = await ctx.db.focusSession.count({ where: { userId: user.id, state: { in: ['collecting_intent', 'running', 'paused'] } } })
    if (active > 0) return { skip: true }
    if (user.reminderPolicy === 1) return {
      text: T.restOver, keyboard: reminderKeyboard(), after: async (tx) => {
        await logEvent(tx, user.id, 'rest_over_sent', { session_id: sessionId }, { at: now, sessionId })
        await ensureNextMeeting(tx, user, now)
      },
    }
    const r = await renderReminder(ctx, user, T.restOver, reminderKeyboard())
    return withEvent(r, async (tx) => {
      await logEvent(tx, user.id, 'rest_over_sent', { session_id: sessionId }, { at: now, sessionId })
      await ensureNextMeeting(tx, user, now)
    })
  }

  if (m.kind === 'break_over') {
    const sessionId = String(p.sessionId ?? '')
    const session = await ctx.db.focusSession.findFirst({ where: { id: sessionId, userId: user.id } })
    if (!session) return { skip: true }
    const paused = session.state === 'paused' && session.pausedAt?.getTime() === Number(p.pausedAt)
    // Исход во время отдыха закрывает сессию, но не отменяет таймер. Проверка
    // последнего pause не позволяет воскресить уведомление старого перерыва.
    let finished = false
    if (session.state === 'finished' && session.restChoice === 'rest') {
      const latestPause = await ctx.db.event.findFirst({
        where: { subjectId: user.subjectId, sessionId, type: 'session_paused' },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      })
      const active = await ctx.db.focusSession.count({ where: { userId: user.id, state: { in: ['collecting_intent', 'running', 'paused'] } } })
      finished = latestPause?.createdAt.getTime() === Number(p.pausedAt) && active === 0
    }
    // Человек уже вернулся, начал новую или ушёл на другой перерыв — молчим.
    if (!paused && !finished) return { skip: true }
    return {
      text: finished ? T.restOver : T.breakOver,
      after: async (tx) => {
        await logEvent(tx, user.id, 'break_over_sent', { session_id: sessionId }, { at: now, sessionId })
      },
    }
  }

  if (m.kind === 'meeting') {
    if (p.defaulted === true && !user.proactive) return { skip: true }
    const active = await ctx.db.focusSession.count({ where: { userId: user.id, state: { in: ['collecting_intent', 'running', 'paused'] } } })
    if (active > 0) return { skip: true }
    if (user.reminderPolicy === 1) {
      // Migrated mornings use the persisted chain. Explicit meetings ask only:
      // no silent-decline mutation, collecting session, or pending-input reset.
      if (p.defaulted === true) return { skip: true }
      return { text: T.meetingPlain, keyboard: reminderKeyboard(), after: async (tx) => {
        await logEvent(tx, user.id, 'meeting_sent', {}, { at: now })
        await ensureNextMeeting(tx, user, now)
      } }
    }
    const hour = localHour(user.timezone, now)
    const taskPrompt = p.morning === true
      ? await buildTaskStartPrompt(ctx, user, T.meetingMorning(hour))
      : null
    const quickKeyboard: Keyboard = [
      [{ text: T.quickStart, data: cb('quick', null, 'start') }],
      [{ text: T.planDay, data: cb('quick', null, 'goal') }],
    ]
    const morningKeyboard = taskPrompt ? [...taskPrompt.keyboard, ...quickKeyboard] : quickKeyboard
    const r = p.morning === true
      ? await renderReminder(ctx, user, taskPrompt?.text ?? T.morningNoTasks(hour), morningKeyboard)
      : await renderReminder(ctx, user, T.meetingPlain, reminderKeyboard())
    return withEvent(r, async (tx) => {
      await tx.user.updateMany({
        where: { id: user.id, pendingInput: { in: ['meeting_time', 'meeting_time_soft'] } },
        data: { pendingInput: 'none' },
      })
      await logEvent(tx, user.id, 'meeting_sent', {}, { at: now })
      if (p.defaulted === true) await logEvent(tx, user.id, 'meeting_defaulted', { minutes_ahead: 0 }, { at: now })
      // Отправленная встреча — не последняя: следующее утро ставится сразу.
      await ensureNextMeeting(tx, user, now)
    })
  }

  if (m.kind === 'summary') {
    const day = String(p.dayKey ?? '')
    if (!user.proactive) return { skip: true }
    const goal = await ctx.db.dailyGoal.findUnique({ where: { userId_dayKey: { userId: user.id, dayKey: day } } })
    if (goal?.summarySentAt) return { skip: true }
    const summary = await buildSummary(ctx.db, user, day, now)
    // A day spent in explicitly chosen idle rest has nothing to report unless
    // actual work or an agreed goal makes this summary meaningful.
    if (user.idleRestAt && summary.sessions === 0 && summary.abandoned === 0 && !summary.inProgress && summary.target === null) return { skip: true }
    return {
      text: T.summary(summary, day === workDayKey(now, user.timezone) ? undefined : day),
      keyboard: [[{ text: T.closeDay, data: cb('sum', null, day.replace(/-/g, '')) }]],
      after: async (tx) => {
        await tx.dailyGoal.upsert({
          where: { userId_dayKey: { userId: user.id, dayKey: day } },
          create: { userId: user.id, dayKey: day, summarySentAt: now },
          update: { summarySentAt: now },
        })
        await logEvent(tx, user.id, 'daily_summary_sent', { day_key: day }, { at: now })
        // Сводка тоже не заканчивается тишиной: встреча на утро ставится сразу.
        await ensureNextMeeting(tx, user, now)
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
  await ctx.db.outboxMessage.updateMany({ where: { id, status: 'sending' }, data: { lockedUntil: null, ...data } })
}

function legacyFingerprint(user: User): string {
  return JSON.stringify([user.pendingInput, user.lastUserActionAt, user.timezone, user.morningTime, user.eveningTime, user.quietUntil, user.idleRestAt, user.proactive, user.pingsEnabled, user.reminderPolicy])
}

async function legacySessionFingerprint(db: Prisma.TransactionClient, m: OutboxMessage): Promise<string> {
  if (!['ping', 'session_end', 'rest_over', 'break_over'].includes(m.kind)) return ''
  const session = await db.focusSession.findFirst({ where: { id: String(payloadOf(m).sessionId ?? ''), userId: m.userId } })
  return JSON.stringify(session && [session.state, session.pausedAt, session.restChoice, session.pingAt, session.pingAnsweredAt, session.finishedAt, session.taskId, session.reminderPolicy])
}

async function legacyEligibility(tx: Prisma.TransactionClient, ctx: Ctx, m: OutboxMessage, user: User): Promise<'skip' | Date | null> {
  if (user.blockedAt) return 'skip'
  const p = payloadOf(m)
  if (['ping', 'session_end', 'rest_over', 'break_over'].includes(m.kind)) {
    const session = await tx.focusSession.findFirst({ where: { id: String(p.sessionId ?? ''), userId: user.id } })
    if (!session || session.reminderPolicy === 1) return 'skip'
  }
  if (m.kind === 'rest_over' && user.idleRestAt) return 'skip'
  if ((m.kind === 'ping' || m.kind === 'rest_over') && hasDecision(user)) return new Date(ctx.now().getTime() + MIN)
  if (m.kind === 'meeting') {
    if (user.reminderPolicy === 1 && (p.defaulted === true)) return 'skip'
    if (p.defaulted === true && (!user.proactive || user.idleRestAt || await morningResolved(tx, user, ctx.now()))) return 'skip'
    if (await tx.focusSession.count({ where: { userId: user.id, state: { in: ['collecting_intent', 'running', 'paused'] } } })) return 'skip'
  }
  if (user.reminderPolicy === 1 && !ctx.remindersEnabled) return new Date(ctx.now().getTime() + 60 * MIN)
  // Explicit legacy timers keep their accepted deadline, including at night.
  // Quiet applies to every mode; work windows apply to unsolicited messages.
  if (user.quietUntil && user.quietUntil > ctx.now()) return user.quietUntil
  if (m.kind === 'summary' || m.kind === 'meeting' && p.defaulted === true || user.reminderPolicy === 1 && m.kind !== 'meeting') {
    const permitted = m.kind === 'summary' ? summaryAllowedAt(user, ctx.now()) : allowedAt(user, { nightUntil: null }, ctx.now())
    if (!permitted) return new Date(ctx.now().getTime() + 60 * MIN)
    if (permitted > ctx.now()) return permitted
  }
  if (m.kind === 'summary' || m.kind === 'meeting') {
    if (!user.proactive && m.kind === 'summary') return 'skip'
    if (m.kind === 'summary') {
      const summaries = await tx.outboxMessage.findMany({ where: { userId: user.id, kind: 'summary', sendAfter: { lte: ctx.now() }, status: { in: ['pending', 'paused', 'sending', 'sent'] } }, select: { payload: true, sentAt: true } })
      const day = String(p.dayKey ?? '')
      // Recovery presents the latest relevant day, never a stack of old days.
      if (summaries.some((entry) => String((entry.payload as Record<string, unknown> | null)?.dayKey ?? '') > day)) return 'skip'
      if (summaries.some((entry) => entry.sentAt && entry.sentAt.getTime() > ctx.now().getTime() - MIN)) return new Date(ctx.now().getTime() + MIN)
    }
    if (hasDecision(user)) return new Date(ctx.now().getTime() + MIN)
    const primary = await tx.reminderChain.findFirst({ where: { userId: user.id, status: 'active' } })
    // A primary question due now or just delivered owns this turn. Do not
    // suppress a summary indefinitely merely because work has a future timer.
    if (primary && (primary.nextDueAt.getTime() <= ctx.now().getTime() + MIN || primary.deliveryAnchorAt && primary.deliveryAnchorAt.getTime() > ctx.now().getTime() - MIN)) return new Date(ctx.now().getTime() + MIN)
    if (m.kind === 'summary') {
      const goal = await tx.dailyGoal.findUnique({ where: { userId_dayKey: { userId: user.id, dayKey: String(p.dayKey ?? '') } } })
      if (goal?.summarySentAt) return 'skip'
    }
  }
  return null
}

async function deliverMigratedLegacy(ctx: Ctx, claimed: OutboxMessage): Promise<void> {
  const token = randomUUID()
  const initial = await ctx.db.$transaction(async (tx) => {
    await lockUser(tx, claimed.userId)
    const m = await tx.outboxMessage.findUnique({ where: { id: claimed.id } })
    const user = await tx.user.findUnique({ where: { id: claimed.userId } })
    if (!m || !user || m.status !== 'sending' || m.generationToken !== claimed.generationToken || m.lockedUntil?.getTime() !== claimed.lockedUntil?.getTime() || !m.lockedUntil || m.lockedUntil <= ctx.now()) return null
    const eligibility = await legacyEligibility(tx, ctx, m, user)
    if (eligibility) {
      await tx.outboxMessage.update({ where: { id: m.id }, data: { status: eligibility === 'skip' ? 'skipped' : 'pending', ...(eligibility === 'skip' ? {} : { sendAfter: eligibility }), lockedUntil: null } })
      return null
    }
    await tx.outboxMessage.update({ where: { id: m.id }, data: { generationToken: token } })
    // The legacy free-mode ping can update missed checks and close a session.
    // Keep those state mutations under the same owner lock as manual actions;
    // this branch makes no LLM/network calls and never nests a transaction.
    const rendered = m.kind === 'ping' ? await render(ctx, m, user, tx) : null
    return { user, fingerprint: legacyFingerprint(user), rendered, sessionFingerprint: rendered ? await legacySessionFingerprint(tx, m) : null }
  })
  if (!initial) return
  let rendered: Render
  try { rendered = initial.rendered ?? await render(ctx, claimed, initial.user) }
  catch (error) {
    log.error('outbox_render_failed', error, { kind: claimed.kind })
    await ctx.db.outboxMessage.updateMany({ where: { id: claimed.id, status: 'sending', generationToken: token }, data: { status: 'failed', lockedUntil: null, lastError: 'render' } })
    return
  }
  if ('skip' in rendered) {
    await ctx.db.outboxMessage.updateMany({ where: { id: claimed.id, status: 'sending', generationToken: token }, data: { status: 'skipped', lockedUntil: null } })
    return
  }
  const msg = 'replace' in rendered ? rendered.replace : rendered
  // Rendering may legitimately finish a legacy free-mode session. Snapshot
  // its resulting state, then fence any subsequent manual phase change.
  const sessionFingerprint = initial.sessionFingerprint ?? await legacySessionFingerprint(ctx.db, claimed)
  const ready = await ctx.db.$transaction(async (tx) => {
    await lockUser(tx, claimed.userId)
    const m = await tx.outboxMessage.findUnique({ where: { id: claimed.id } })
    const user = await tx.user.findUnique({ where: { id: claimed.userId } })
    if (!m || !user || m.status !== 'sending' || m.generationToken !== token || !m.lockedUntil || m.lockedUntil <= ctx.now()) return null
    const eligibility = await legacyEligibility(tx, ctx, m, user)
    const changed = legacyFingerprint(user) !== initial.fingerprint || await legacySessionFingerprint(tx, m) !== sessionFingerprint
    const gateBusy = user.sendGateUntil && user.sendGateUntil > ctx.now()
    if (eligibility || changed || gateBusy) {
      const skip = eligibility === 'skip'
      const due = eligibility instanceof Date ? eligibility : gateBusy ? user.sendGateUntil! : new Date(ctx.now().getTime() + MIN)
      await tx.outboxMessage.update({ where: { id: m.id }, data: { status: skip ? 'skipped' : 'pending', sendAfter: due, lockedUntil: null } })
      return null
    }
    const started = ctx.now()
    await tx.user.update({ where: { id: user.id }, data: { sendGateToken: token, sendGateUntil: new Date(started.getTime() + LEASE_MS) } })
    await tx.outboxMessage.update({ where: { id: m.id }, data: { sendAttemptStartedAt: started, lockedUntil: new Date(started.getTime() + LEASE_MS), contextFingerprint: initial.fingerprint } })
    return user
  })
  if (!ready) return
  let error: unknown
  try { await ctx.tg.send(ready.tgId, msg.text, msg.keyboard) } catch (caught) { error = caught }
  await ctx.db.$transaction(async (tx) => {
    await lockUser(tx, claimed.userId)
    const m = await tx.outboxMessage.findUnique({ where: { id: claimed.id } })
    const user = await tx.user.findUnique({ where: { id: claimed.userId } })
    if (m?.status === 'sending' && m.generationToken === token && user) {
      let data: Prisma.OutboxMessageUpdateInput
      if (error === undefined) data = { status: 'sent', sentAt: ctx.now() }
      else if (error instanceof TelegramError && error.code === 429) data = { status: 'pending', sendAfter: new Date(ctx.now().getTime() + (error.retryAfterSec ?? 30) * 1000), sendAttemptStartedAt: null, lastError: '429' }
      else if (error instanceof DeliveryError && !error.maybeSent && m.attempts < MAX_ATTEMPTS) data = { status: 'pending', sendAfter: new Date(ctx.now().getTime() + 30_000 * m.attempts), sendAttemptStartedAt: null, lastError: error.code.slice(0, 40) }
      else if (error instanceof TelegramError || error instanceof DeliveryError && !error.maybeSent) data = { status: 'failed', lastError: error instanceof TelegramError ? String(error.code) : error.code.slice(0, 40) }
      else data = { status: 'uncertain', lastError: error instanceof DeliveryError ? error.code.slice(0, 40) : 'unknown' }
      await tx.outboxMessage.update({ where: { id: m.id }, data: { ...data, lockedUntil: null } })
      // Never let an old rendered turn clear a newer manual pending input.
      if (error === undefined && legacyFingerprint(user) === initial.fingerprint) await msg.after?.(tx)
      if (error instanceof TelegramError && error.code === 403) {
        await tx.user.update({ where: { id: user.id }, data: { blockedAt: ctx.now() } })
        await tx.outboxMessage.updateMany({ where: { userId: user.id, status: { in: ['pending', 'paused'] } }, data: { status: 'canceled' } })
      }
    }
    await tx.user.updateMany({ where: { id: claimed.userId, sendGateToken: token }, data: { sendGateToken: null, sendGateUntil: null } })
  })
  if (error === undefined) {
    rememberConversationContext(claimed.userId, 'assistant', msg.text, ctx.now())
    const user = await ctx.db.user.findUnique({ where: { id: claimed.userId } })
    if (user) rememberQuestion(user.id, user.pendingInput, ctx.now(), `outbox_${claimed.kind}`)
    await rememberTaskNumberPrompt(ctx, claimed.userId, msg.text, msg.keyboard)
  }
}

async function recoverMigratedLegacy(ctx: Ctx, claimed: OutboxMessage): Promise<void> {
  await ctx.db.$transaction(async (tx) => {
    await lockUser(tx, claimed.userId)
    const m = await tx.outboxMessage.findUnique({ where: { id: claimed.id } })
    if (!m || m.status !== 'sending' || !m.lockedUntil || m.lockedUntil >= ctx.now()) return
    await tx.outboxMessage.update({ where: { id: m.id }, data: { status: m.sendAttemptStartedAt ? 'uncertain' : 'pending', sendAfter: ctx.now(), generationToken: null, lockedUntil: null, lastError: 'lease_expired' } })
    if (m.generationToken) await tx.user.updateMany({ where: { id: m.userId, sendGateToken: m.generationToken }, data: { sendGateToken: null, sendGateUntil: null } })
  })
}

async function deliver(ctx: Ctx, m: OutboxMessage): Promise<void> {
  if (m.kind === 'reminder') return deliverReminder(ctx, m)
  const user = await ctx.db.user.findUnique({ where: { id: m.userId } })
  if (!user || user.blockedAt) return finish(ctx, m.id, { status: 'skipped' })
  // Every policy shares the owner-locked, fresh-state send gate.
  return deliverMigratedLegacy(ctx, m)
}

async function markUncertain(ctx: Ctx, m: OutboxMessage, code: string): Promise<void> {
  await ctx.db.$transaction(async (tx) => {
    const res = await tx.outboxMessage.updateMany({
      where: { id: m.id, status: 'sending', lockedUntil: m.lockedUntil },
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
  for (const m of stuck) {
    if (m.kind === 'reminder') await recoverReminder(ctx, m)
    else if (m.generationToken) await recoverMigratedLegacy(ctx, m)
    else await markUncertain(ctx, m, 'lease_expired')
  }
}

export async function runOutboxOnce(ctx: Ctx): Promise<number> {
  await recoverStuck(ctx)
  let processed = 0
  while (processed < BATCH) {
    const [m] = await claim(ctx)
    if (!m) break
    processed++
    try {
      await deliver(ctx, m)
    } catch (error) {
      // Ошибка после отправки (например, при записи отметки): статус остаётся
      // sending, и через аренду строка станет uncertain — не дубль.
      log.error('outbox_deliver_failed', error, { kind: m.kind })
    }
  }
  return processed
}
