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
    const mark = (day: string, counted = 1) => prisma.$transaction((tx) => markDayActive(tx, u.id, day, at, counted))
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
  it('разрыв можно починить двумя заходами за день в течение трёх дней, раз в 30 дней', async () => {
    const u = await prisma.user.create({ data: { tgId: 2n } })
    const mark = (day: string, counted = 1) => prisma.$transaction((tx) => markDayActive(tx, u.id, day, at, counted))
    for (const d of ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04']) await mark(d)
    // Пропуск 5 дней при двух заморозках — разрыв, но чинимый.
    const broken = await mark('2026-09-10')
    expect(broken.broken).toEqual({ previous: 4, repairable: true })
    expect(broken.current).toBe(1)
    await mark('2026-09-11')
    const repaired = await mark('2026-09-11', 2)
    expect(repaired.repaired).toBe(true)
    expect(repaired.current).toBe(6)
    // Второй разрыв в пределах 30 дней — уже не чинится.
    const again = await mark('2026-09-20')
    expect(again.broken).toEqual({ previous: 6, repairable: false })
  })

  it('окно починки истекает через три дня', async () => {
    const u = await prisma.user.create({ data: { tgId: 3n } })
    const mark = (day: string, counted = 1) => prisma.$transaction((tx) => markDayActive(tx, u.id, day, at, counted))
    for (const d of ['2026-09-01', '2026-09-02', '2026-09-03']) await mark(d)
    await mark('2026-09-10')
    const late = await mark('2026-09-13', 2)
    expect(late.repaired).toBe(false)
  })

  it('объявленный выходной не пропуск: заморозка не тратится', async () => {
    const u = await prisma.user.create({ data: { tgId: 4n } })
    const mark = (day: string) => prisma.$transaction((tx) => markDayActive(tx, u.id, day, at, 1))
    await mark('2026-09-01')
    await prisma.dayOff.create({ data: { userId: u.id, dayKey: '2026-09-02' } })
    const r = await mark('2026-09-03')
    expect([r.current, r.freezesLeft, r.missedDays, r.frozenDays]).toEqual([2, 2, 0, 0])
  })
})
