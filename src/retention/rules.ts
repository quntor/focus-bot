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
  // Возвращение меньше сессии и не чаще раза в 14 дней: пропадать не должно быть
  // выгодно. Только после пропуска, который не закрыла заморозка.
  comeback: 5,
} as const

export const DAILY_CAP = 80
export const COMEBACK_MIN_GAP_DAYS = 3
export const COMEBACK_COOLDOWN_DAYS = 14

export const FREEZES_MAX = 2
// +1 заморозка за каждые 7 дней серии подряд, но не больше FREEZES_MAX.
export const FREEZE_REFILL_EVERY = 7

export function isCounted(state: string, elapsedMinutes: number): boolean {
  return state === 'finished' && elapsedMinutes >= MIN_COUNTED_MINUTES
}
