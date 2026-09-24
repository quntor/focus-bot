import { describe, expect, it } from 'vitest'
import { summarize, type ZachetDay } from './zachet.js'

const day = (i: number, dau: number, perDau: number): ZachetDay => ({
  day_msk: `2026-11-${String(i + 3).padStart(2, '0')}`,
  dau,
  calls_strict: dau * perDau,
  calls_all: dau * (perDau + 5),
})

describe('сводка зачётного периода', () => {
  it('допуск: 14 дней из 28 с DAU ≥ 1000, среднее DAU ≥ 1000 и ≥ 10 обращений на DAU', () => {
    const rows = Array.from({ length: 28 }, (_, i) => day(i, i < 14 ? 1_500 : 600, 12))
    const s = summarize(rows, 28)
    expect(s.daysAtMinDau).toBe(14)
    expect(s.avgDau).toBe(1_050)
    expect(s.avgStrictPerDau).toBe(12)
    expect(s.admittedStrict).toBe(true)
  })

  it('13 дней с порогом — не устойчиво, даже при высоком среднем', () => {
    const rows = Array.from({ length: 28 }, (_, i) => day(i, i < 13 ? 3_000 : 900, 12))
    expect(summarize(rows, 28).admittedStrict).toBe(false)
  })

  it('пустые дни периода — нули в среднем DAU, а не пропуск', () => {
    // 20 дней по 1000, 8 дней без единого пользователя: среднее ниже порога.
    const rows = Array.from({ length: 20 }, (_, i) => day(i, 1_000, 12))
    const s = summarize(rows, 28)
    expect(s.avgDau).toBeCloseTo(714.29, 2)
    expect(s.admittedStrict).toBe(false)
  })

  it('строгий подсчёт ниже порога, полный — выше: допуск различается', () => {
    const rows = Array.from({ length: 28 }, (_, i) => day(i, 1_200, 8))
    const s = summarize(rows, 28)
    expect([s.avgStrictPerDau, s.avgAllPerDau]).toEqual([8, 13])
    expect([s.admittedStrict, s.admittedAll]).toEqual([false, true])
  })
})
