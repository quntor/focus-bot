// Сутки пользователя, а не сервера. От границы дня зависят DAU, серия и цель
// дня, поэтому ключ дня считается в его часовом поясе и хранится строкой
// YYYY-MM-DD: по ней сравнивают, группируют и сверяют с выгрузкой, и она не
// зависит от того, в каком поясе запущен процесс.
export function dayKey(at: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at)
  return parts
}

// Расстояние в днях между двумя ключами. Серия растёт при 1, держится при 0,
// рвётся при большем — с поправкой на заморозку, которая живёт в src/retention.
export function daysBetween(from: string, to: string): number {
  const ms = Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)
  return Math.round(ms / 86_400_000)
}

// Сдвиг ключа дня на n суток. Арифметика по UTC-полуночи: ключ — календарная
// дата без пояса, и сдвиг не должен зависеть от перехода на летнее время.
export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

// Понедельник недели, в которую попадает день. Неделя — с понедельника.
export function weekStart(day: string): string {
  const weekday = (new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7
  return addDays(day, -weekday)
}
