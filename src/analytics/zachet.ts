// Пороги Положения конкурса Sber500xDisrupt (Приложение 2, пп. 3–4). Здесь и
// только здесь: методика может быть скорректирована организатором (сноска 10).
export const ZACHET = {
  // Зачётный период — 28 календарных дней, предшествующих 30.11.2026 включительно.
  periodDays: 28,
  // «Устойчиво» — значение достигнуто не менее чем в 14 из 28 дней.
  steadyDays: 14,
  minDau: 1_000,
  minCallsPerDau: 10,
  // Номинация 1 «Высокочастотная поверхность».
  highFrequencyCallsPerDau: 35,
  // Номинация 2 «Массовый охват», устойчиво.
  massReachDau: 2_500,
} as const

export type ZachetDay = {
  day_msk: string
  dau: number
  calls_strict: number
  calls_all: number
}

export type ZachetSummary = {
  days: number
  avgDau: number
  daysAtMinDau: number
  daysAtMassReach: number
  // Среднесуточно — среднее дневных отношений (так читается «среднесуточно за
  // Зачётный период»). Отношение сумм — рядом, на случай иной трактовки.
  avgStrictPerDau: number
  avgAllPerDau: number
  pooledStrictPerDau: number
  pooledAllPerDau: number
  // Общий допуск к номинациям по трём условиям п. 3 (кроме антифрода и
  // техаудита), для строгого и полного подсчёта обращений.
  admittedStrict: boolean
  admittedAll: boolean
}

const round2 = (x: number) => Math.round(x * 100) / 100
const mean = (xs: number[]) => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length)

// Дни без единого активного пользователя в представлении отсутствуют; для
// среднего DAU они считаются нулями — иначе пустые дни завышали бы среднее.
export function summarize(rows: ZachetDay[], periodDays: number = rows.length): ZachetSummary {
  const days = Math.max(periodDays, rows.length)
  const dauSum = rows.reduce((a, r) => a + r.dau, 0)
  const avgDau = days === 0 ? 0 : dauSum / days
  const withDau = rows.filter((r) => r.dau > 0)
  const avgStrictPerDau = mean(withDau.map((r) => r.calls_strict / r.dau))
  const avgAllPerDau = mean(withDau.map((r) => r.calls_all / r.dau))
  const daysAtMinDau = rows.filter((r) => r.dau >= ZACHET.minDau).length
  const dauOk = daysAtMinDau >= ZACHET.steadyDays && avgDau >= ZACHET.minDau
  return {
    days,
    avgDau: round2(avgDau),
    daysAtMinDau,
    daysAtMassReach: rows.filter((r) => r.dau >= ZACHET.massReachDau).length,
    avgStrictPerDau: round2(avgStrictPerDau),
    avgAllPerDau: round2(avgAllPerDau),
    pooledStrictPerDau: dauSum === 0 ? 0 : round2(rows.reduce((a, r) => a + r.calls_strict, 0) / dauSum),
    pooledAllPerDau: dauSum === 0 ? 0 : round2(rows.reduce((a, r) => a + r.calls_all, 0) / dauSum),
    admittedStrict: dauOk && avgStrictPerDau >= ZACHET.minCallsPerDau,
    admittedAll: dauOk && avgAllPerDau >= ZACHET.minCallsPerDau,
  }
}
