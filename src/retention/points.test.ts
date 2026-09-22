import { beforeEach, describe, expect, it } from 'vitest'
import { hasDb, prisma, resetDb } from '../test/db.js'
import { award } from './points.js'
import { DAILY_CAP } from './rules.js'
import { markDayActive } from './streak.js'

const at = new Date('2026-09-22T10:00:00Z')

describe.skipIf(!hasDb)('начисления', () => {
  beforeEach(resetDb)

  it('идемпотентны по refKey, даже при параллельных вызовах', async () => {
    const u = await prisma.user.create({ data: { tgId: 1n } })
    const call = () => prisma.$transaction((tx) => award(tx, { userId: u.id, dayKey: '2026-09-22', reason: 'session_completed', refKey: 'session:x', amount: 10, at }))
    const results = await Promise.all([call(), call(), call()])
    expect(results.sort()).toEqual([0, 0, 10])
    expect(await prisma.pointsEntry.count()).toBe(1)
  })

  it('потолок в сутки соблюдается и под гонкой', async () => {
    const u = await prisma.user.create({ data: { tgId: 1n } })
    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        prisma.$transaction((tx) => award(tx, { userId: u.id, dayKey: '2026-09-22', reason: 'session_completed', refKey: `session:${i}`, amount: 10, at })),
      ),
    )
    const sum = await prisma.pointsEntry.aggregate({ where: { userId: u.id, dayKey: '2026-09-22' }, _sum: { amount: true } })
    expect(sum._sum.amount).toBe(DAILY_CAP)
    expect(await prisma.event.count({ where: { type: 'points_capped' } })).toBeGreaterThan(0)
    // Другой день — свой потолок.
    await prisma.$transaction((tx) => award(tx, { userId: u.id, dayKey: '2026-09-23', reason: 'session_completed', refKey: 'session:next', amount: 10, at }))
    expect(await prisma.pointsEntry.count({ where: { dayKey: '2026-09-23' } })).toBe(1)
  })
})

describe.skipIf(!hasDb)('серия', () => {
  beforeEach(resetDb)

  it('пропуск закрывается заморозкой, длинный пропуск рвёт серию без траты заморозок', async () => {
    const u = await prisma.user.create({ data: { tgId: 1n } })
    const mark = (day: string) => prisma.$transaction((tx) => markDayActive(tx, u.id, day, at))
    await mark('2026-09-01')
    await mark('2026-09-02')
    await mark('2026-09-04') // пропущен 3-е — заморозка
    let s = await prisma.streak.findUniqueOrThrow({ where: { userId: u.id } })
    expect([s.current, s.freezesLeft]).toEqual([3, 1])
    await mark('2026-09-04') // тот же день — без изменений
    await mark('2026-09-10') // пропущено 5 дней при одной заморозке — сброс
    s = await prisma.streak.findUniqueOrThrow({ where: { userId: u.id } })
    expect([s.current, s.freezesLeft, s.best]).toEqual([1, 1, 3])
  })
})
