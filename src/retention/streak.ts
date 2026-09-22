import type { Db } from '../lib/db.js'
import { daysBetween } from '../lib/day.js'
import { logEvent } from '../analytics/log.js'
import { FREEZES_MAX, FREEZE_REFILL_EVERY } from './rules.js'

// Серия. День засчитывается, если в сутках пользователя есть хотя бы одна
// засчитанная сессия. Правило одно на всю неделю: задачи не обязательно рабочие,
// «пойду приготовлю ужин» — тоже сессия, выходных у серии нет.
//
// Пропуск закрывается заморозкой автоматически, в момент следующей активности:
// всё вычисляется по дням, а не по таймеру, и воспроизводимо по журналу.
// Пропуск длиннее запаса заморозок рвёт серию и заморозки не тратит.
export type StreakResult = { current: number; reset: boolean; missedDays: number }

function nextDay(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

export async function markDayActive(db: Db, userId: string, day: string, at: Date): Promise<StreakResult> {
  const streak =
    (await db.streak.findUnique({ where: { userId } })) ??
    (await db.streak.create({ data: { userId } }))

  if (streak.lastActiveDay === day) return { current: streak.current, reset: false, missedDays: 0 }
  // Сессия задним числом (ночная, закрытая после полуночи в другом поясе) серию
  // назад не двигает.
  if (streak.lastActiveDay && daysBetween(streak.lastActiveDay, day) < 0) {
    return { current: streak.current, reset: false, missedDays: 0 }
  }

  const gap = streak.lastActiveDay ? daysBetween(streak.lastActiveDay, day) : 1
  const missed = Math.max(0, gap - 1)
  let { current, freezesLeft } = streak
  let frozenDay = streak.frozenDay
  let reset = false

  if (streak.lastActiveDay === null) {
    current = 1
  } else if (missed === 0) {
    current += 1
  } else if (missed <= freezesLeft) {
    for (let i = 1; i <= missed; i++) {
      const frozen = nextDay(streak.lastActiveDay, i)
      freezesLeft -= 1
      frozenDay = frozen
      await logEvent(db, userId, 'streak_frozen', { day_key: frozen, freezes_left: freezesLeft }, { at })
    }
    current += 1
  } else {
    await logEvent(db, userId, 'streak_reset', { day_key: day, previous: current }, { at })
    current = 1
    reset = true
  }

  if (current % FREEZE_REFILL_EVERY === 0 && freezesLeft < FREEZES_MAX) freezesLeft += 1

  await db.streak.update({
    where: { userId },
    data: { current, best: Math.max(streak.best, current), lastActiveDay: day, freezesLeft, frozenDay },
  })
  await logEvent(db, userId, 'streak_extended', { day_key: day, current }, { at })
  return { current, reset, missedDays: missed }
}
