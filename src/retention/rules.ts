// Правила учёта. Не адаптируются никогда — ни профилем, ни техникой, ни моделью:
// метрики проходят внешнюю проверку и должны быть воспроизводимы. Любая правка
// здесь — это изменение правил для всех пользователей задним числом, и делать
// её можно только осознанно, с записью в docs/metrics.md.

// Засчитанная сессия: доведена до исхода (любого из трёх) и длилась не меньше
// порога. Порог нужен против фермы: /focus и сразу «сделал». За «не сделал»
// очков столько же, сколько за «сделал»: иначе люди начнут писать «сделал»
// всегда, и память по задачам превратится в мусор.
export const MIN_COUNTED_MINUTES = 10

export const POINTS = {
  session_completed: 10,
  daily_goal: 20,
  // Возвращение после пропуска. Лучшая из 54 программ мегаисследования
  // спортзалов — микронаграда за возвращение после пропущенной тренировки
  // (Milkman et al., Nature 2021). Поэтому — после любого пропущенного дня, в
  // том числе закрытого заморозкой. Меньше сессии и не чаще раза в 14 дней:
  // пропадать ради бонуса не должно быть выгодно.
  comeback: 5,
} as const

export const DAILY_CAP = 80
// Пропущенных дней (без объявленных выходных) для бонуса возвращения.
export const COMEBACK_MIN_GAP_DAYS = 1
export const COMEBACK_COOLDOWN_DAYS = 14

export const FREEZES_MAX = 2
// +1 заморозка за каждые 7 дней серии подряд, но не больше FREEZES_MAX.
export const FREEZE_REFILL_EVERY = 7

// Починка серии: два засчитанных захода за день в течение REPAIR_WINDOW_DAYS
// дней после разрыва (день возвращения и два следующих). Не чаще раза в 30 дней
// и только для серии от двух дней.
export const REPAIR_SESSIONS = 2
export const REPAIR_WINDOW_DAYS = 3
export const REPAIR_COOLDOWN_DAYS = 30
export const REPAIR_MIN_STREAK = 2

// Объявленный выходной: не больше одного в календарную неделю (с понедельника).
export const DAYS_OFF_PER_WEEK = 1

export function isCounted(state: string, elapsedMinutes: number): boolean {
  return state === 'finished' && elapsedMinutes >= MIN_COUNTED_MINUTES
}
