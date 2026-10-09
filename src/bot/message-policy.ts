import type { Prisma, User } from '@prisma/client'
import { addDays, dayKey } from '../lib/day.js'
import { localDateTime } from '../lib/time.js'

// Durable facts, shared by scheduling and both pre-send gates. Neither a
// cancelled preparation nor yesterday's work answers today's plan question.
export async function workedToday(tx: Prisma.TransactionClient, user: User, now: Date): Promise<boolean> {
  const day = dayKey(now, user.timezone)
  const from = localDateTime(user.timezone, day, { h: 0, m: 0 })
  const until = localDateTime(user.timezone, addDays(day, 1), { h: 0, m: 0 })
  return Boolean(await tx.focusSession.count({ where: { userId: user.id, startedAt: { gte: from, lt: until } } }))
}

export async function morningResolved(tx: Prisma.TransactionClient, user: User, now: Date): Promise<boolean> {
  const localDate = dayKey(now, user.timezone)
  if (await tx.calendarPlan.count({ where: { userId: user.id, localDate } })) return true
  if (await workedToday(tx, user, now)) return true
  // A delivered invitation is sufficient: silence is not permission to ask
  // the identical question hourly. Keep its buttons valid for the same day.
  const today = {
    gte: localDateTime(user.timezone, localDate, { h: 0, m: 0 }),
    lt: localDateTime(user.timezone, addDays(localDate, 1), { h: 0, m: 0 }),
  }
  return Boolean(await tx.outboxMessage.count({ where: {
    userId: user.id, status: { in: ['sent', 'uncertain'] },
    OR: [
      { chain: { kind: 'morning', localDate } },
      { kind: 'meeting', OR: [{ payload: { path: ['defaulted'], equals: true } }, { payload: { path: ['morning'], equals: true } }],
        AND: [{ OR: [{ sendAttemptStartedAt: today }, { sentAt: today }] }] },
    ],
  } }))
}

export const hasDecision = (user: Pick<User, 'pendingInput'>): boolean => user.pendingInput !== 'none'
