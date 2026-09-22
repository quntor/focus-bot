import { beforeEach, describe, expect, it } from 'vitest'
import { hasDb, prisma, resetDb } from '../test/db.js'
import { makeBot } from '../test/bot.js'

const A = 7001
const DAY = 24 * 60

async function session(bot: ReturnType<typeof makeBot>, text = 'шаг, 30 минут') {
  await bot.text(A, text)
  const user = await prisma.user.findUniqueOrThrow({ where: { tgId: BigInt(A) } })
  const s = await prisma.focusSession.findFirstOrThrow({ where: { userId: user.id, state: 'running' } })
  bot.advance(30)
  await bot.press(A, `out:${s.id}:done`)
  const afterOutcome = bot.lastText(A)
  await bot.press(A, `skiprep:${s.id}:`)
  await bot.press(A, `rest:${s.id}:rest`)
  return { user, afterOutcome }
}

describe.skipIf(!hasDb)('геймификация в сообщениях', () => {
  beforeEach(resetDb)

  it('после сессии — прогресс к цели', async () => {
    const bot = makeBot()
    await bot.onboard(A)
    await bot.text(A, '/goal 3')
    const { afterOutcome } = await session(bot)
    expect(afterOutcome).toContain('1 из 3 — осталось 2 захода.')
  })

  it('пропуск закрыт заморозкой — об этом сказано; возвращение после одного дня — бонус', async () => {
    const bot = makeBot()
    await bot.onboard(A)
    const { user } = await session(bot)
    bot.advance(2 * DAY)
    const { afterOutcome } = await session(bot)
    expect(afterOutcome).toContain('Вчера был пропуск — закрыл его заморозкой, осталась 1.')
    expect(afterOutcome).toContain('С возвращением!')
    const comeback = await prisma.pointsEntry.findMany({ where: { userId: user.id, reason: 'comeback' } })
    expect(comeback.map((p) => p.amount)).toEqual([5])
  })

  it('разрыв без вины, потом починка двумя заходами', async () => {
    const bot = makeBot()
    await bot.onboard(A)
    await session(bot)
    bot.advance(DAY)
    await session(bot)
    bot.advance(5 * DAY)
    const first = await session(bot)
    expect(first.afterOutcome).toContain('Серия в 2 дня прервалась — не страшно')
    const second = await session(bot)
    expect(second.afterOutcome).toContain('Серия восстановлена: 3 дня.')
  })

  it('выходной: не больше одного в неделю, серию не рвёт', async () => {
    // Вторник, 10:00 по Москве.
    const bot = makeBot({ now: new Date('2026-09-22T07:00:00Z') })
    await bot.onboard(A)
    const { user } = await session(bot)
    await bot.text(A, '/dayoff')
    expect(bot.lastText(A)).toContain('Завтра выходной — серия не прервётся')
    await bot.text(A, '/dayoff')
    expect(bot.lastText(A)).toContain('выходной уже был')
    bot.advance(2 * DAY)
    await session(bot)
    const streak = await prisma.streak.findUniqueOrThrow({ where: { userId: user.id } })
    expect([streak.current, streak.freezesLeft]).toEqual([2, 2])
    // Выходной — не пропуск, бонуса возвращения нет.
    expect(await prisma.pointsEntry.count({ where: { userId: user.id, reason: 'comeback' } })).toBe(0)
  })

  it('сводка: неделя к неделе и активные дни из 7', async () => {
    const bot = makeBot({ now: new Date('2026-09-15T07:00:00Z') })
    await bot.onboard(A)
    await session(bot) // вторник прошлой недели: 10 очков
    bot.advance(7 * DAY)
    await session(bot)
    await session(bot) // вторник этой недели: 20 за сессии + 5 за возвращение
    await bot.text(A, '/today')
    const text = bot.lastText(A)
    expect(text).toContain('За неделю: 25 очков — на 15 больше, чем к этому дню прошлой недели. Лучшая неделя!')
    expect(text).toContain('Активных дней за последние 7: 1 из 7.')
  })
})
