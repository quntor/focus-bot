import type { Db } from '../lib/db.js'
import { addDays, daysBetween } from '../lib/day.js'
import { logEvent } from '../analytics/log.js'
import {
  FREEZES_MAX,
  FREEZE_REFILL_EVERY,
  REPAIR_COOLDOWN_DAYS,
  REPAIR_MIN_STREAK,
  REPAIR_SESSIONS,
  REPAIR_WINDOW_DAYS,
} from './rules.js'

// Серия. День засчитывается, если в сутках пользователя есть хотя бы одна
// засчитанная сессия. Правило одно на всю неделю: задачи не обязательно рабочие,
// «пойду приготовлю ужин» — тоже сессия. Заранее объявленный выходной — не
// пропуск (src/retention/rules.ts, DAYS_OFF_PER_WEEK).
//
// Пропуск закрывается заморозкой автоматически, в момент следующей активности:
// всё вычисляется по дням, а не по таймеру, и воспроизводимо по журналу.
// Пропуск длиннее запаса рвёт серию и заморозки не тратит, но серию можно
// починить: единичный пропуск почти не мешает формированию привычки
// (Lally et al., 2010), и наказывать за него обнулением — терять человека.
export type StreakResult = {
  current: number
  // Реально пропущенные дни — без объявленных выходных.
  missedDays: number
  frozenDays: number
  freezesLeft: number
  // Серия прервалась в этот раз: previous — сколько было, repairable — можно ли
  // её починить.
  broken: { previous: number; repairable: boolean } | null
  repaired: boolean
}

export async function markDayActive(
  db: Db,
  userId: string,
  day: string,
  at: Date,
  countedToday: number,
): Promise<StreakResult> {
  const streak =
    (await db.streak.findUnique({ where: { userId } })) ??
    (await db.streak.create({ data: { userId } }))

  let { current, freezesLeft, repairFrom, repairUntil, lastRepairDay } = streak
  let frozenDay = streak.frozenDay
  let missed = 0
  let frozen = 0
  let broken: StreakResult['broken'] = null
  let extended = false

  // Окно починки истекло — забываем о нём.
  if (repairUntil && day > repairUntil) {
    repairFrom = null
    repairUntil = null
  }

  const newDay = streak.lastActiveDay !== day
  // Сессия задним числом (ночная, закрытая после полуночи в другом поясе) серию
  // назад не двигает.
  const backwards = streak.lastActiveDay !== null && daysBetween(streak.lastActiveDay, day) < 0

  if (newDay && !backwards) {
    extended = true
    if (streak.lastActiveDay === null) {
      current = 1
    } else {
      const between: string[] = []
      for (let i = 1; i < daysBetween(streak.lastActiveDay, day); i++) between.push(addDays(streak.lastActiveDay, i))
      const off = between.length
        ? new Set((await db.dayOff.findMany({ where: { userId, dayKey: { in: between } }, select: { dayKey: true } })).map((d) => d.dayKey))
        : new Set<string>()
      const missedList = between.filter((d) => !off.has(d))
      missed = missedList.length

      if (missed === 0) {
        current += 1
      } else if (missed <= freezesLeft) {
        for (const d of missedList) {
          freezesLeft -= 1
          frozen += 1
          frozenDay = d
          await logEvent(db, userId, 'streak_frozen', { day_key: d, freezes_left: freezesLeft }, { at })
        }
        current += 1
      } else {
        const previous = current
        const cooledDown = lastRepairDay === null || daysBetween(lastRepairDay, day) >= REPAIR_COOLDOWN_DAYS
        const repairable = previous >= REPAIR_MIN_STREAK && cooledDown
        await logEvent(db, userId, 'streak_reset', { day_key: day, previous, repairable }, { at })
        broken = { previous, repairable }
        current = 1
        repairFrom = repairable ? previous : null
        repairUntil = repairable ? addDays(day, REPAIR_WINDOW_DAYS - 1) : null
      }
    }
    if (current % FREEZE_REFILL_EVERY === 0 && freezesLeft < FREEZES_MAX) freezesLeft += 1
  }

  // Починка: второй засчитанный заход за день в окне — серия возвращается,
  // а дни с момента разрыва продолжают её.
  let repaired = false
  if (repairFrom !== null && repairUntil !== null && day <= repairUntil && countedToday >= REPAIR_SESSIONS) {
    current = repairFrom + current
    repairFrom = null
    repairUntil = null
    lastRepairDay = day
    repaired = true
    await logEvent(db, userId, 'streak_repaired', { day_key: day, current }, { at })
  }

  if (!extended && !repaired) {
    return { current, missedDays: 0, frozenDays: 0, freezesLeft, broken: null, repaired: false }
  }

  await db.streak.update({
    where: { userId },
    data: {
      current,
      best: Math.max(streak.best, current),
      lastActiveDay: extended ? day : streak.lastActiveDay,
      freezesLeft,
      frozenDay,
      repairFrom,
      repairUntil,
      lastRepairDay,
    },
  })
  if (extended) await logEvent(db, userId, 'streak_extended', { day_key: day, current }, { at })
  return { current, missedDays: missed, frozenDays: frozen, freezesLeft, broken, repaired }
}
