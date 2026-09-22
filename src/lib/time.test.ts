import { describe, expect, it } from 'vitest'
import { nextLocalTime, parseClock, zoneFromLocalClock } from './time.js'

describe('пояс по названному времени', () => {
  const now = new Date('2026-09-22T07:00:00Z')
  it.each([
    ['10:00', 'Europe/Moscow'],
    ['17:00', 'Asia/Vladivostok'],
    ['12:00', 'Asia/Yekaterinburg'],
    ['07:00', 'UTC'],
    ['12:30', 'Asia/Kolkata'],
    ['03:00', 'Etc/GMT+4'],
  ])('%s → %s', (clock, zone) => {
    expect(zoneFromLocalClock(parseClock(clock)!, now).timezone).toBe(zone)
  })
  it('через полночь', () => {
    // 22:30 UTC, у человека 01:30 — это Москва, а не UTC−21.
    expect(zoneFromLocalClock({ h: 1, m: 30 }, new Date('2026-09-22T22:30:00Z')).timezone).toBe('Europe/Moscow')
  })
})

describe('время', () => {
  it('разбирает часы и минуты', () => {
    expect(parseClock('9:05')).toEqual({ h: 9, m: 5 })
    expect(parseClock('21.40')).toEqual({ h: 21, m: 40 })
    expect(parseClock('25:00')).toBeNull()
    expect(parseClock('завтра')).toBeNull()
  })
  it('ближайшее HH:MM в поясе пользователя', () => {
    const now = new Date('2026-09-22T07:00:00Z') // 10:00 в Москве
    expect(nextLocalTime('Europe/Moscow', { h: 21, m: 0 }, now).toISOString()).toBe('2026-09-22T18:00:00.000Z')
    expect(nextLocalTime('Europe/Moscow', { h: 9, m: 0 }, now).toISOString()).toBe('2026-09-23T06:00:00.000Z')
  })
})
