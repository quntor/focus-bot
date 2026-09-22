import { describe, expect, it } from 'vitest'
import { computeRole } from './roles.js'

const now = new Date('2026-10-01T12:00:00Z')
const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000)

describe('роль', () => {
  it('новичок — первая неделя и меньше трёх засчитанных сессий', () => {
    expect(computeRole({ createdAt: daysAgo(2), countedSessions: 1, lastUserActionAt: now, observesOnly: false }, now)).toBe('new')
    expect(computeRole({ createdAt: daysAgo(2), countedSessions: 3, lastUserActionAt: now, observesOnly: false }, now)).toBe('active')
  })

  it('активный и уснувший различаются по последнему действию', () => {
    expect(computeRole({ createdAt: daysAgo(30), countedSessions: 10, lastUserActionAt: daysAgo(6), observesOnly: false }, now)).toBe('active')
    expect(computeRole({ createdAt: daysAgo(30), countedSessions: 10, lastUserActionAt: daysAgo(8), observesOnly: false }, now)).toBe('dormant')
    expect(computeRole({ createdAt: daysAgo(30), countedSessions: 0, lastUserActionAt: null, observesOnly: false }, now)).toBe('dormant')
  })

  it('наблюдатель — смотрит за другим и сам не работает', () => {
    expect(computeRole({ createdAt: daysAgo(30), countedSessions: 5, lastUserActionAt: now, observesOnly: true }, now)).toBe('observer')
  })
})
