import { describe, expect, it } from 'vitest'
import { dayKey, daysBetween } from './day.js'

describe('dayKey', () => {
  it('отдаёт календарный день в поясе пользователя', () => {
    // 31 декабря 21:30 UTC — это уже 1 января в Москве.
    const at = new Date('2026-12-31T21:30:00Z')
    expect(dayKey(at, 'Europe/Moscow')).toBe('2027-01-01')
    expect(dayKey(at, 'UTC')).toBe('2026-12-31')
  })

  it('ночная сессия остаётся в своём дне', () => {
    const at = new Date('2026-09-14T22:10:00Z')
    expect(dayKey(at, 'Asia/Vladivostok')).toBe('2026-09-15')
  })
})

describe('daysBetween', () => {
  it('считает разницу через границу месяца', () => {
    expect(daysBetween('2026-09-30', '2026-10-01')).toBe(1)
    expect(daysBetween('2026-09-14', '2026-09-14')).toBe(0)
    expect(daysBetween('2026-09-10', '2026-09-14')).toBe(4)
  })
})
