import { beforeEach, describe, expect, it } from 'vitest'
import { makeBot } from '../test/bot.js'
import { hasDb, prisma, resetDb } from '../test/db.js'

const A = 54101
const text = 'Начать сессию'
const action = (value: 'start' | 'focus') => ({ route: 'control', action: value, text, value: null, followUp: null })

describe.skipIf(!hasDb)('SBER500-41 quick start without returning preamble', () => {
  beforeEach(resetDb)
  it.each(['start', 'focus'] as const)('%s starts a returning user without old ritual or question', async route => {
    const bot = makeBot()
    await bot.setupOnboarded(A)
    const user = await prisma.user.findUniqueOrThrow({ where: { tgId: BigInt(A) } })
    await prisma.user.update({ where: { id: user.id }, data: { ritualText: 'Глажу кошку, включаю комп.' } })
    const task = await prisma.task.create({ data: { userId: user.id, title: 'Анализ SEO-продвижения Милавицы', nextStep: 'делать фокус-бот' } })
    await prisma.focusSession.deleteMany({ where: { userId: user.id } })
    await prisma.focusSession.create({ data: { userId: user.id, state: 'finished', taskId: task.id, intentText: task.title, plannedMinutes: 25, startedAt: bot.now(), finishedAt: bot.now() } })
    const before = bot.textsTo(A).length
    await bot.textAs(A, text, action(route))
    const running = await prisma.focusSession.findMany({ where: { userId: user.id, state: 'running' } })
    expect(running).toHaveLength(1)
    expect(running[0]).toMatchObject({ taskId: null, intentText: null, startedAt: bot.now() })
    const output = bot.textsTo(A).slice(before).join('\n')
    expect(output).not.toMatch(/С возвращением|Ритуал:|В прошлый раз|С чего начнёшь\?/)
    expect(bot.textsTo(A).slice(before)).toHaveLength(1)
    expect(output).toContain('Сессия началась')
  })
  it.each(['running', 'paused'] as const)('model start preserves %s timer and state', async state => {
    const bot = makeBot()
    await bot.setupOnboarded(A)
    await bot.textAs(A, text, action('focus'))
    const current = await prisma.focusSession.findFirstOrThrow({ where: { state: 'running' } })
    if (state === 'paused') await prisma.focusSession.update({ where: { id: current.id }, data: { state, pausedAt: bot.now() } })
    const before = await prisma.focusSession.findUniqueOrThrow({ where: { id: current.id } })
    bot.advance(1)
    await bot.textAs(A, text, action('start'))
    expect(await prisma.focusSession.findUniqueOrThrow({ where: { id: current.id } })).toEqual(before)
    expect(await prisma.focusSession.count({ where: { userId: current.userId } })).toBe(1)
  })
})
