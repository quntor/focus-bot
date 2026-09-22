import { beforeEach, describe, expect, it } from 'vitest'
import { hasDb, prisma, resetDb } from '../test/db.js'
import { makeBot } from '../test/bot.js'
import { sweepOnce } from '../jobs/sweeper.js'

const A = 3001

async function userOf(tgId: number) {
  return prisma.user.findUniqueOrThrow({ where: { tgId: BigInt(tgId) } })
}

describe.skipIf(!hasDb)('целостность учёта', () => {
  beforeEach(resetDb)

  it('повторный update_id не создаёт второй сессии, начисления и сообщения', async () => {
    const bot = makeBot()
    await bot.onboard(A)
    await bot.text(A, 'глава, 30 минут', 900_000)
    await bot.text(A, 'глава, 30 минут', 900_000)
    const user = await userOf(A)
    expect(await prisma.focusSession.count({ where: { userId: user.id } })).toBe(1)

    const s = await prisma.focusSession.findFirstOrThrow({ where: { userId: user.id } })
    bot.advance(30)
    const sentBefore = bot.tg.sent.length
    await bot.press(A, `out:${s.id}:done`, 900_001)
    await bot.press(A, `out:${s.id}:done`, 900_001)
    expect(bot.tg.sent.length).toBe(sentBefore + 1)
    expect(await prisma.pointsEntry.count({ where: { userId: user.id } })).toBe(1)
  })

  it('две параллельные /focus создают одну сессию', async () => {
    const bot = makeBot()
    await bot.onboard(A)
    await Promise.all([bot.text(A, '/focus'), bot.text(A, '/focus'), bot.text(A, 'глава'), bot.text(A, 'введение')])
    const user = await userOf(A)
    const active = await prisma.focusSession.count({ where: { userId: user.id, state: { in: ['collecting_intent', 'running'] } } })
    expect(active).toBe(1)
  })

  it('повторное нажатие исхода на другой доставке не начисляет второй раз', async () => {
    const bot = makeBot()
    await bot.onboard(A)
    await bot.text(A, 'глава, 30 минут')
    const user = await userOf(A)
    const s = await prisma.focusSession.findFirstOrThrow({ where: { userId: user.id } })
    bot.advance(30)
    await Promise.all([bot.press(A, `out:${s.id}:done`), bot.press(A, `out:${s.id}:not_done`)])
    expect(await prisma.pointsEntry.count({ where: { userId: user.id } })).toBe(1)
    const events = await prisma.event.count({ where: { type: 'session_completed' } })
    expect(events).toBe(1)
  })

  it('abandoned не даёт очков: /stop и таймаут', async () => {
    const bot = makeBot()
    await bot.onboard(A)
    await bot.text(A, 'глава, 30 минут')
    bot.advance(25)
    await bot.text(A, '/stop')
    await bot.text(A, 'введение, 30 минут')
    bot.advance(30 + 61)
    await sweepOnce(bot.ctx)
    const user = await userOf(A)
    const states = (await prisma.focusSession.findMany({ where: { userId: user.id } })).map((s) => s.state)
    expect(states).toEqual(['abandoned', 'abandoned'])
    expect(await prisma.pointsEntry.count({ where: { userId: user.id } })).toBe(0)
    expect((await prisma.streak.findUnique({ where: { userId: user.id } }))?.current ?? 0).toBe(0)
  })

  it('короткая сессия (меньше 10 минут) закрывается, но очков и серии не даёт', async () => {
    const bot = makeBot()
    await bot.onboard(A)
    await bot.text(A, 'глава, 30 минут')
    const user = await userOf(A)
    const s = await prisma.focusSession.findFirstOrThrow({ where: { userId: user.id } })
    bot.advance(3)
    await bot.press(A, `out:${s.id}:done`)
    const done = await prisma.focusSession.findUniqueOrThrow({ where: { id: s.id } })
    expect(done.state).toBe('finished')
    expect(done.counted).toBe(false)
    expect(await prisma.pointsEntry.count({ where: { userId: user.id } })).toBe(0)
  })

  it('в журнал не попадает ни намерение, ни отчёт', async () => {
    const bot = makeBot()
    await bot.onboard(A)
    await bot.text(A, 'написать Кате про увольнение, 30 минут')
    const user = await userOf(A)
    const s = await prisma.focusSession.findFirstOrThrow({ where: { userId: user.id } })
    bot.advance(30)
    await bot.press(A, `out:${s.id}:other`)
    await bot.text(A, 'разобрал анализы вместо этого')
    const dump = JSON.stringify(await prisma.event.findMany(), (_k, v) => (typeof v === 'bigint' ? v.toString() : v))
    expect(dump).not.toContain('Кате')
    expect(dump).not.toContain('анализы')
    expect(dump).not.toContain(user.id)
  })
})
