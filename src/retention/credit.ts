import type { Db } from '../lib/db.js'
import { logEvent } from '../analytics/log.js'
import { award } from './points.js'
import { COMEBACK_COOLDOWN_DAYS, COMEBACK_MIN_GAP_DAYS, POINTS } from './rules.js'
import { markDayActive } from './streak.js'

// Всё, что следует из засчитанной сессии: цель дня, серия, очки. Вызывается в
// той же транзакции, что и переход сессии в finished. Брошенная и отменённая
// сессии сюда не попадают никогда — вызывающий проверяет counted.
export async function creditCountedSession(
  db: Db,
  input: { userId: string; sessionId: string; dayKey: string; at: Date },
): Promise<{ goalReached: boolean }> {
  const { userId, sessionId, dayKey, at } = input

  await db.user.update({ where: { id: userId }, data: { countedSessions: { increment: 1 } } })

  const goal = await db.dailyGoal.upsert({
    where: { userId_dayKey: { userId, dayKey } },
    create: { userId, dayKey, completedSessions: 1 },
    update: { completedSessions: { increment: 1 } },
  })

  const streak = await markDayActive(db, userId, dayKey, at)

  await award(db, { userId, dayKey, reason: 'session_completed', refKey: `session:${sessionId}`, amount: POINTS.session_completed, at })

  let goalReached = false
  if (goal.targetSessions !== null && goal.completedSessions >= goal.targetSessions && goal.goalReachedAt === null) {
    // Условие на goalReachedAt в самом UPDATE: цель закрывается ровно один раз.
    const closed = await db.dailyGoal.updateMany({
      where: { id: goal.id, goalReachedAt: null },
      data: { goalReachedAt: at },
    })
    if (closed.count === 1) {
      goalReached = true
      await logEvent(db, userId, 'goal_reached', { day_key: dayKey, target_sessions: goal.targetSessions }, { at })
      await award(db, { userId, dayKey, reason: 'daily_goal', refKey: `goal:${userId}:${dayKey}`, amount: POINTS.daily_goal, at })
    }
  }

  if (streak.reset && streak.missedDays >= COMEBACK_MIN_GAP_DAYS) {
    const since = new Date(at.getTime() - COMEBACK_COOLDOWN_DAYS * 86_400_000)
    const recent = await db.pointsEntry.count({ where: { userId, reason: 'comeback', createdAt: { gte: since } } })
    if (recent === 0) {
      await award(db, { userId, dayKey, reason: 'comeback', refKey: `comeback:${userId}:${dayKey}`, amount: POINTS.comeback, at })
    }
  }

  return { goalReached }
}
