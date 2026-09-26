import { beforeEach, describe, expect, it } from 'vitest'
import { hasDb, prisma, resetDb } from '../test/db.js'
import { makeBot } from '../test/bot.js'

const A = 6001

describe.skipIf(!hasDb)('граница дня — по поясу пользователя', () => {
  beforeEach(resetDb)

  it('сессия в 01:30 по Владивостоку засчитывается в его день, а не в день сервера', async () => {
    // 15:00 UTC = 01:00 следующего дня во Владивостоке (UTC+10).
    const bot = makeBot({ now: new Date('2026-09-22T15:00:00Z') })
    await bot.onboard(A, '01:00')
    const user = await prisma.user.findUniqueOrThrow({ where: { tgId: BigInt(A) } })
    expect(user.timezone).toBe('Asia/Vladivostok')
    await bot.text(A, 'глава, 30 минут')
    const s = await prisma.focusSession.findFirstOrThrow({ where: { userId: user.id } })
    bot.advance(30)
    await bot.press(A, `out:${s.id}:done`)
    const entry = await prisma.pointsEntry.findFirstOrThrow({ where: { userId: user.id } })
    expect(entry.dayKey).toBe('2026-09-23')
    const goal = await prisma.dailyGoal.findFirstOrThrow({ where: { userId: user.id } })
    expect(goal.dayKey).toBe('2026-09-23')
    const events = await prisma.event.findMany({ where: { type: 'session_completed' } })
    expect(events[0]?.dayKey).toBe('2026-09-23')
  })

  it('цель дня: очки один раз, когда её выполнила сессия', async () => {
    const bot = makeBot()
    await bot.onboard(A)
    await bot.text(A, '/goal 2')
    const user = await prisma.user.findUniqueOrThrow({ where: { tgId: BigInt(A) } })
    for (let i = 0; i < 3; i++) {
      await bot.text(A, `шаг ${i}, 30 минут`)
      const s = await prisma.focusSession.findFirstOrThrow({ where: { userId: user.id, state: 'running' } })
      bot.advance(30)
      await bot.press(A, `out:${s.id}:done`)
      await bot.press(A, `skiprep:${s.id}:`)
      await bot.press(A, `rest:${s.id}:continue`)
    }
    const goalPoints = await prisma.pointsEntry.findMany({ where: { userId: user.id, reason: 'daily_goal' } })
    expect(goalPoints.map((p) => p.amount)).toEqual([20])
  })
})

describe.skipIf(!hasDb)('/delete_me', () => {
  beforeEach(resetDb)

  it('удаляет пользователя и весь его текст по-настоящему, журнал обезличен', async () => {
    const bot = makeBot()
    await bot.onboard(A)
    await bot.text(A, 'написать Кате про увольнение, 30 минут')
    const user = await prisma.user.findUniqueOrThrow({ where: { tgId: BigInt(A) } })
    const s = await prisma.focusSession.findFirstOrThrow({ where: { userId: user.id } })
    bot.advance(30)
    await bot.press(A, `out:${s.id}:done`)
    await bot.text(A, 'разобрал анализы')
    await bot.text(A, '/delete_me')
    await bot.press(A, 'del::confirm')

    expect(await prisma.user.count()).toBe(0)
    for (const count of [prisma.task.count(), prisma.focusSession.count(), prisma.outboxMessage.count(), prisma.pointsEntry.count(), prisma.dailyGoal.count(), prisma.streak.count()]) {
      expect(await count).toBe(0)
    }
    // События остались, но связать их с человеком больше нечем.
    const events = await prisma.event.findMany()
    expect(events.length).toBeGreaterThan(0)
    expect(events.every((e) => e.subjectId === user.subjectId)).toBe(true)
    expect(await prisma.user.count({ where: { subjectId: user.subjectId } })).toBe(0)
    expect(bot.lastText(A)).toContain('удалено')
  })

  it('новый пользователь проходит настройку времени без согласия и не сохраняет её как задачу', async () => {
    const bot = makeBot()
    await bot.text(A, '/start')
    expect(bot.lastText(A)).toContain('Сколько у тебя сейчас времени?')
    expect(bot.lastText(A)).not.toContain('согласие')
    await bot.text(A, '10:00')
    expect(await prisma.focusSession.count()).toBe(0)
    expect(await prisma.task.count()).toBe(0)
  })
})
