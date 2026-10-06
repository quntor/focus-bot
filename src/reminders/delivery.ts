import { createHash, randomUUID } from 'node:crypto'
import type { OutboxMessage, Prisma, ReminderChain, User } from '@prisma/client'
import type { Ctx } from '../bot/context.js'
import { rememberTaskNumberPrompt } from '../bot/task-number-prompt.js'
import { rememberConversationContext, rememberQuestion } from '../bot/conversation-context.js'
import { llmMeter } from '../analytics/calls.js'
import { logEvent } from '../analytics/log.js'
import type { EventPayload } from '../analytics/payloads.js'
import { dayKey } from '../lib/day.js'
import { fallbackReminder, generateReminder, type ReminderContext, type ReminderPhase } from '../llm/reminder.js'
import { DeliveryError, TelegramError, type Keyboard } from '../tg/client.js'
import { allowedAt } from './cadence.js'
import { advance, cancelChain, lockUser } from './store.js'

const LEASE_MS = 60_000
const phases = ['morning', 'work', 'break', 'post_rest'] as const
type Tx = Prisma.TransactionClient

export function reminderKeyboard(id: string, phase: ReminderPhase): Keyboard {
  const cycle = (action: string) => `cycle:${id}:${action}`
  const main = phase === 'morning'
    ? [{ text: 'Сегодня работаю', data: `morning:${id}:work` }, { text: 'Сегодня выходной', data: `morning:${id}:off` }]
    : phase === 'work'
      ? [{ text: 'Пора отдыхать', data: cycle('break') }, { text: 'Продолжить работу', data: cycle('continue') }]
      : [{ text: 'Вернуться к работе', data: cycle('resume') }, { text: 'Ещё отдыхаю', data: cycle('rest') }]
  return [main, [{ text: 'Сегодня больше не беспокоить', data: cycle('stop') }], [{ text: 'Отключить уведомления', data: cycle('quiet') }]]
}

async function snapshot(tx: Tx, m: OutboxMessage, now: Date) {
  const user = await tx.user.findUnique({ where: { id: m.userId } })
  const chain = m.chainId ? await tx.reminderChain.findUnique({ where: { id: m.chainId } }) : null
  if (!user || !chain || chain.userId !== user.id || chain.status !== 'active' || chain.revision !== m.chainRevision || chain.ordinal !== m.ordinal || !phases.includes(chain.kind as ReminderPhase)) return null
  const phase = chain.kind as ReminderPhase
  const localDate = dayKey(now, user.timezone)
  const plan = await tx.calendarPlan.findUnique({ where: { userId_localDate: { userId: user.id, localDate } } })
  const active = await tx.focusSession.findFirst({ where: { userId: user.id, state: { in: ['running', 'paused', 'collecting_intent'] } } })
  const session = chain.sessionId ? await tx.focusSession.findFirst({ where: { id: chain.sessionId, userId: user.id } }) : null
  if (phase === 'morning' && (chain.localDate !== localDate || plan || active)) return null
  if (phase === 'work' && (!session || session.state !== 'running' || session.plannedMinutes === null)) return null
  if (phase === 'break' && (!session || session.state !== 'paused')) return null
  if (phase === 'post_rest' && (active || !session || session.state !== 'finished' || session.restChoice !== 'rest')) return null
  const tasks = await tx.task.findMany({ where: { userId: user.id, status: 'active' }, orderBy: [{ lastSessionAt: 'desc' }, { id: 'asc' }], take: 3, select: { id: true, title: true } })
  const current = session?.taskId ? await tx.task.findFirst({ where: { id: session.taskId, userId: user.id }, select: { id: true, title: true, status: true } }) : null
  const previous = await tx.outboxMessage.findFirst({ where: { userId: user.id, chainId: chain.id, id: { not: m.id }, status: { in: ['sent', 'uncertain'] }, generatedText: { not: null } }, orderBy: [{ ordinal: 'desc' }, { createdAt: 'desc' }], select: { generatedText: true } })
  const context: ReminderContext = {
    phase, localDate, timeZone: user.timezone,
    todayPlan: plan ? { localDate, text: plan.answer } : null,
    currentWork: current?.status === 'active' ? { id: current.id, title: current.title } : !current && session?.intentText ? { id: null, title: session.intentText } : null,
    tasks, lastReport: session?.reportText ?? null, lastAnswer: plan?.answer ?? null,
    previousText: previous?.generatedText ?? null,
  }
  const fingerprint = createHash('sha256').update(JSON.stringify({ context, session: session ? [session.id, session.state, session.taskId, session.intentText, session.pausedAt, session.plannedMinutes] : null, revision: chain.revision })).digest('hex')
  return { user, chain, context, fingerprint }
}

function deferAt(user: User, chain: ReminderChain, now: Date): Date | null {
  if (user.blockedAt || user.reminderPolicy === 0) return null
  // The legacy midpoint toggle must not swallow the first timer deadline.
  // Later checks remain optional; quiet/window/global guards still apply below.
  const checksDisabled = chain.kind === 'morning' || chain.kind === 'post_rest'
    ? !user.proactive
    : !user.pingsEnabled && chain.ordinal > 0
  if (checksDisabled) return new Date(now.getTime() + 60 * 60_000)
  const quiet = user.quietUntil && user.quietUntil > now ? user.quietUntil : now
  return allowedAt(user, chain, quiet) ?? new Date(now.getTime() + 60 * 60_000)
}

async function releaseGate(tx: Tx, userId: string, token: string) {
  await tx.user.updateMany({ where: { id: userId, sendGateToken: token }, data: { sendGateToken: null, sendGateUntil: null } })
}

async function deliveryEvent(tx: Tx, message: OutboxMessage, status: EventPayload<'reminder_delivery'>['status'], now: Date) {
  const chain = message.chainId ? await tx.reminderChain.findUnique({ where: { id: message.chainId } }) : null
  if (!chain || message.chainRevision === null || message.ordinal === null || !phases.includes(chain.kind as ReminderPhase)) return
  if (!await tx.user.findUnique({ where: { id: message.userId }, select: { id: true } })) return
  await logEvent(tx, message.userId, 'reminder_delivery', {
    chain_id: chain.id, outbox_id: message.id, kind: chain.kind as ReminderPhase,
    revision: message.chainRevision, ordinal: message.ordinal, status,
    due_ms: message.sendAfter.getTime(), due_lag_ms: Math.max(0, now.getTime() - message.sendAfter.getTime()),
    ...(message.sendAttemptStartedAt ? { anchor_ms: message.sendAttemptStartedAt.getTime() } : {}),
  }, { at: now })
}

export async function deliverReminder(ctx: Ctx, claimed: OutboxMessage): Promise<void> {
  const token = randomUUID()
  const initial = await ctx.db.$transaction(async (tx) => {
    await lockUser(tx, claimed.userId)
    const m = await tx.outboxMessage.findUnique({ where: { id: claimed.id } })
    if (!m || m.status !== 'sending' || m.generationToken !== claimed.generationToken || m.lockedUntil?.getTime() !== claimed.lockedUntil?.getTime() || !m.lockedUntil || m.lockedUntil <= ctx.now()) return null
    if (!ctx.remindersEnabled) {
      await tx.outboxMessage.update({ where: { id: m.id }, data: { status: 'canceled', lastError: 'policy_disabled', lockedUntil: null } })
      await deliveryEvent(tx, m, 'disabled', ctx.now())
      return null
    }
    const state = await snapshot(tx, m, ctx.now())
    if (!state) { await tx.outboxMessage.update({ where: { id: m.id }, data: { status: 'canceled', lockedUntil: null } }); await deliveryEvent(tx, m, 'stale', ctx.now()); return null }
    const due = ctx.remindersEnabled ? deferAt(state.user, state.chain, ctx.now()) : new Date(ctx.now().getTime() + 60 * 60_000)
    if (!due) { await cancelChain(tx, state.chain.id); await deliveryEvent(tx, m, 'blocked', ctx.now()); return null }
    if (due > ctx.now()) { await tx.outboxMessage.update({ where: { id: m.id }, data: { status: 'pending', sendAfter: due, lockedUntil: null } }); await deliveryEvent(tx, m, state.user.quietUntil && state.user.quietUntil > ctx.now() ? 'quiet' : 'window', ctx.now()); return null }
    const uncertainGeneration = m.generationStatus === 'started' || m.generationStatus === 'uncertain' || Boolean(m.generatedText && m.contextFingerprint !== state.fingerprint)
    const cached = m.generatedText && m.contextFingerprint === state.fingerprint ? m.generatedText : null
    await tx.outboxMessage.update({ where: { id: m.id }, data: { generationToken: token, generationStatus: cached ? 'ready' : uncertainGeneration ? 'uncertain' : 'started' } })
    return { ...state, cached, uncertainGeneration }
  })
  if (!initial) return
  const generated = initial.cached ? { result: { text: initial.cached }, provenance: 'llm' as const }
    : initial.uncertainGeneration ? { result: fallbackReminder(initial.context.phase), provenance: 'fallback' as const }
      : await generateReminder(ctx.llm, initial.context, llmMeter(ctx, claimed.userId, 'reminder_text', initial.chain.sessionId))

  const ready = await ctx.db.$transaction(async (tx) => {
    await lockUser(tx, claimed.userId)
    const m = await tx.outboxMessage.findUnique({ where: { id: claimed.id } })
    if (!m || m.status !== 'sending' || m.generationToken !== token || !m.lockedUntil || m.lockedUntil <= ctx.now()) return null
    if (!ctx.remindersEnabled) {
      await tx.outboxMessage.update({ where: { id: m.id }, data: { status: 'canceled', lastError: 'policy_disabled', lockedUntil: null } })
      await deliveryEvent(tx, m, 'disabled', ctx.now())
      return null
    }
    const state = await snapshot(tx, m, ctx.now())
    if (!state) { await tx.outboxMessage.update({ where: { id: m.id }, data: { status: 'canceled', lockedUntil: null } }); await deliveryEvent(tx, m, 'stale', ctx.now()); return null }
    const changed = state.fingerprint !== initial.fingerprint
    const text = changed ? fallbackReminder(state.context.phase).text : generated.result.text
    const provenance = changed ? 'fallback' : initial.cached ? m.provenance ?? 'fallback' : generated.provenance
    await tx.outboxMessage.update({ where: { id: m.id }, data: { generatedText: text, contextFingerprint: state.fingerprint, provenance, generationStatus: 'ready' } })
    if ((changed || !initial.cached) && m.chainId && m.chainRevision !== null && m.ordinal !== null) {
      const failure = 'failure' in generated ? generated.failure : null
      await logEvent(tx, m.userId, 'reminder_generated', {
        chain_id: m.chainId, outbox_id: m.id, kind: state.context.phase, revision: m.chainRevision, ordinal: m.ordinal,
        provenance: provenance === 'llm' ? 'llm' : 'fallback',
        llm_reason: changed ? 'stale' : initial.uncertainGeneration ? 'uncertain' : failure && !failure.ok ? failure.reason : null,
      }, { at: ctx.now() })
      if (failure && !failure.ok) await logEvent(tx, m.userId, 'llm_fallback', { stage: 'reminder_text', reason: failure.reason }, { at: ctx.now() })
    }
    const due = ctx.remindersEnabled ? deferAt(state.user, state.chain, ctx.now()) : new Date(ctx.now().getTime() + 60 * 60_000)
    if (!due) { await cancelChain(tx, state.chain.id); await deliveryEvent(tx, m, 'blocked', ctx.now()); return null }
    const gateBusy = state.user.sendGateUntil && state.user.sendGateUntil > ctx.now()
    if (due > ctx.now() || gateBusy) {
      const sendAfter = gateBusy && state.user.sendGateUntil! > due ? state.user.sendGateUntil! : due
      await tx.outboxMessage.update({ where: { id: m.id }, data: { status: 'pending', sendAfter, lockedUntil: null } })
      await deliveryEvent(tx, m, gateBusy ? 'gate_busy' : !ctx.remindersEnabled ? 'disabled' : state.user.quietUntil && state.user.quietUntil > ctx.now() ? 'quiet' : 'window', ctx.now())
      return null
    }
    const started = ctx.now()
    await tx.user.update({ where: { id: state.user.id }, data: { sendGateToken: token, sendGateUntil: new Date(started.getTime() + LEASE_MS) } })
    await tx.outboxMessage.update({ where: { id: m.id }, data: { sendAttemptStartedAt: started, lockedUntil: new Date(started.getTime() + LEASE_MS) } })
    return { user: state.user, text, phase: state.context.phase }
  })
  if (!ready) return
  let error: unknown
  try { await ctx.tg.send(ready.user.tgId, ready.text, reminderKeyboard(claimed.id, ready.phase)) }
  catch (caught) { error = caught }
  await ctx.db.$transaction(async (tx) => {
    await lockUser(tx, claimed.userId)
    const m = await tx.outboxMessage.findUnique({ where: { id: claimed.id } })
    if (!m || m.status !== 'sending' || m.generationToken !== token) { await releaseGate(tx, claimed.userId, token); return }
    const chain = m.chainId ? await tx.reminderChain.findUnique({ where: { id: m.chainId } }) : null
    const current = chain?.status === 'active' && chain.revision === m.chainRevision
    if (!ctx.remindersEnabled && (error instanceof TelegramError && error.code === 429 || error instanceof DeliveryError && !error.maybeSent)) {
      await tx.outboxMessage.update({ where: { id: m.id }, data: { status: 'canceled', lastError: 'policy_disabled', sendAttemptStartedAt: null, lockedUntil: null } })
      await deliveryEvent(tx, m, 'disabled', ctx.now())
      await releaseGate(tx, claimed.userId, token)
      return
    }
    if (error instanceof TelegramError && error.code === 429) {
      await tx.outboxMessage.update({ where: { id: m.id }, data: { status: current ? 'pending' : 'canceled', sendAfter: new Date(ctx.now().getTime() + (error.retryAfterSec ?? 30) * 1000), sendAttemptStartedAt: null, lockedUntil: null, lastError: '429' } })
      await deliveryEvent(tx, m, current ? 'retry' : 'stale', ctx.now())
    } else if (error instanceof DeliveryError && !error.maybeSent && m.attempts < 5 && current) {
      await tx.outboxMessage.update({ where: { id: m.id }, data: { status: 'pending', sendAfter: new Date(ctx.now().getTime() + 30_000 * m.attempts), sendAttemptStartedAt: null, lockedUntil: null, lastError: error.code.slice(0, 40) } })
      await deliveryEvent(tx, m, 'retry', ctx.now())
    } else {
      const failed = error instanceof TelegramError || error instanceof DeliveryError && !error.maybeSent
      const status = error === undefined ? 'sent' : failed ? 'failed' : 'uncertain'
      await tx.outboxMessage.update({ where: { id: m.id }, data: { status, sentAt: status === 'sent' ? ctx.now() : null, lockedUntil: null, lastError: error instanceof TelegramError ? String(error.code) : error instanceof DeliveryError ? error.code.slice(0, 40) : error ? 'unknown' : null } })
      await deliveryEvent(tx, m, error instanceof TelegramError && error.code === 403 ? 'blocked' : status, ctx.now())
      if (error instanceof TelegramError && error.code === 403) {
        await tx.user.update({ where: { id: m.userId }, data: { blockedAt: ctx.now() } })
        await tx.outboxMessage.updateMany({ where: { userId: m.userId, status: { in: ['pending', 'paused'] } }, data: { status: 'canceled' } })
        if (chain) await cancelChain(tx, chain.id)
      } else if (error instanceof TelegramError) {
        if (chain) await cancelChain(tx, chain.id)
      } else if (current && chain) {
        await advance(tx, chain, status === 'uncertain' ? m.sendAttemptStartedAt ?? ctx.now() : ctx.now())
        if (!ctx.remindersEnabled) await tx.outboxMessage.updateMany({ where: { chainId: chain.id, status: 'pending' }, data: { status: 'canceled', lastError: 'policy_disabled' } })
      }
    }
    await releaseGate(tx, claimed.userId, token)
  })
  if (error === undefined) {
    rememberConversationContext(claimed.userId, 'assistant', ready.text, ctx.now())
    const user = await ctx.db.user.findUnique({ where: { id: claimed.userId }, select: { pendingInput: true } })
    if (user) rememberQuestion(claimed.userId, user.pendingInput, ctx.now(), `reminder_${ready.phase}`)
    await rememberTaskNumberPrompt(ctx, claimed.userId, ready.text, reminderKeyboard(claimed.id, ready.phase))
  }
}

export async function recoverReminder(ctx: Ctx, claimed: OutboxMessage): Promise<void> {
  await ctx.db.$transaction(async (tx) => {
    await lockUser(tx, claimed.userId)
    const m = await tx.outboxMessage.findUnique({ where: { id: claimed.id } })
    if (!m || m.status !== 'sending' || !m.lockedUntil || m.lockedUntil >= ctx.now()) return
    if (!ctx.remindersEnabled && !m.sendAttemptStartedAt) {
      await tx.outboxMessage.update({ where: { id: m.id }, data: { status: 'canceled', lastError: 'policy_disabled', generationToken: null, generationStatus: m.generationStatus === 'started' ? 'uncertain' : m.generationStatus, lockedUntil: null } })
      await deliveryEvent(tx, m, 'disabled', ctx.now())
      if (m.generationToken) await releaseGate(tx, m.userId, m.generationToken)
      return
    }
    const chain = m.chainId ? await tx.reminderChain.findUnique({ where: { id: m.chainId } }) : null
    const current = chain?.status === 'active' && chain.revision === m.chainRevision
    if (m.sendAttemptStartedAt) {
      await tx.outboxMessage.update({ where: { id: m.id }, data: { status: 'uncertain', generationToken: null, lockedUntil: null, lastError: 'lease_expired' } })
      if (current && chain) {
        await advance(tx, chain, m.sendAttemptStartedAt)
        if (!ctx.remindersEnabled) await tx.outboxMessage.updateMany({ where: { chainId: chain.id, status: 'pending' }, data: { status: 'canceled', lastError: 'policy_disabled' } })
      }
    } else {
      await tx.outboxMessage.update({ where: { id: m.id }, data: { status: current ? 'pending' : 'canceled', generationToken: null, generationStatus: m.generationStatus === 'started' ? 'uncertain' : m.generationStatus, lockedUntil: null, sendAfter: ctx.now() } })
    }
    await deliveryEvent(tx, m, m.sendAttemptStartedAt ? 'uncertain' : current ? 'recovered' : 'stale', ctx.now())
    if (m.generationToken) await releaseGate(tx, m.userId, m.generationToken)
  })
}
