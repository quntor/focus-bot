import type { FocusSession, Prisma, User } from '@prisma/client'
import { workDayKey } from '../lib/day.js'
import { transition, StaleTransition } from '../session/fsm.js'
import { logEvent } from '../analytics/log.js'
import { closePeriod, projectAllocations } from './accounting.js'
import { cancelPrimary } from './store.js'

/** Existing product workdays start at04:00 local. A current-day explicit
 * extension is authoritative; crossing calendar midnight alone is not sleep. */
export function overnightCutoff(session: FocusSession, timezone: string, now: Date): Date | null {
  const end = session.plannedEndAt
  return session.reminderPolicy === 1 && session.state === 'running' && session.plannedMinutes !== null &&
    end !== null && session.startedAt !== null && end >= session.startedAt && end <= now &&
    workDayKey(end, timezone) < workDayKey(now, timezone) ? end : null
}

/** Caller holds the owner lock and input/snapshot fence. No outcome or credit
 * is inferred from sleep. Only the final open period is cut; history survives. */
export async function settleOvernightReturn(tx: Prisma.TransactionClient, user: User, session: FocusSession, now: Date): Promise<boolean> {
  const end = overnightCutoff(session, user.timezone, now)
  if (!end || session.userId !== user.id) return false
  const periods = await tx.workPeriod.findMany({ where: { sessionId: session.id }, orderBy: { startedAt: 'asc' } })
  if (periods.some(p => p.startedAt > end || p.endedAt !== null && p.endedAt > end)) throw new StaleTransition()
  await closePeriod(tx, session.id, end)
  const total = await projectAllocations(tx, user.id, session.id, end)
  await transition(tx, { sessionId: session.id, userId: user.id }, 'running', 'finished', { finishedAt: end, outcome: null, counted: false })
  await cancelPrimary(tx, user.id)
  await tx.outboxMessage.updateMany({ where: { userId: user.id, status: { in: ['pending', 'paused', 'sending'] }, OR: [
    { idempotencyKey: { startsWith: `ping:${session.id}` } }, { idempotencyKey: { startsWith: `session_end:${session.id}` } },
  ] }, data: { status: 'canceled' } })
  // Do not consume an unrelated task/settings dialogue.
  if (['session_end', 'running_work', 'running_duration', 'running_task_choice'].some(kind => user.pendingInput.startsWith(`${kind}:${session.id}`))) {
    await tx.user.update({ where: { id: user.id }, data: { pendingInput: 'none' } })
  }
  await logEvent(tx, user.id, 'session_auto_finished', { session_id: session.id, elapsed_minutes: Math.floor(total.totalSeconds / 60), counted: false, reason: 'overnight_return' }, { at: now, sessionId: session.id })
  return true
}
