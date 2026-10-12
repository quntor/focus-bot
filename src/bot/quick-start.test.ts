import { beforeEach, describe, expect, it } from 'vitest'
import { makeBot } from '../test/bot.js'
import { hasDb, prisma, resetDb } from '../test/db.js'
import { buildSummary } from './day-flow.js'

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
  it('model start preserves an already running timer and state', async () => {
    const bot = makeBot()
    await bot.setupOnboarded(A)
    await bot.textAs(A, text, action('focus'))
    const current = await prisma.focusSession.findFirstOrThrow({ where: { state: 'running' } })
    const before = await prisma.focusSession.findUniqueOrThrow({ where: { id: current.id } })
    bot.advance(1)
    await bot.textAs(A, text, action('start'))
    expect(await prisma.focusSession.findUniqueOrThrow({ where: { id: current.id } })).toEqual(before)
    expect(await prisma.focusSession.count({ where: { userId: current.userId } })).toBe(1)
  })
  it.each([0, 1] as const)('starts immediately from break under reminder policy %s', async policy => {
    for (const control of ['focus', 'start', 'callback'] as const) {
      await resetDb()
      const bot = makeBot()
      bot.ctx.remindersEnabled = policy === 1
      bot.ctx.reminderUserIds = [String(A)]
      await bot.setupOnboarded(A)
      const user = await prisma.user.findUniqueOrThrow({ where: { tgId: BigInt(A) } })
      await prisma.user.update({ where: { id: user.id }, data: { technique: 'pomodoro' } })
      await bot.textAs(A, text, action('focus'))
      const old = await prisma.focusSession.findFirstOrThrow({ where: { userId: user.id, state: 'running' } })
      expect(old.reminderPolicy).toBe(policy)
      bot.advance(10)
      await bot.textAs(A, 'Перерыв', { text: 'Перерыв', route: 'break', minutes: null, durationSource: null, followUp: null })
      expect(await prisma.focusSession.findUniqueOrThrow({ where: { id: old.id } })).toMatchObject({ state: 'paused' })
      bot.advance(5)
      const before = bot.textsTo(A).length
      if (control === 'callback') await bot.press(A, 'quick::start')
      else await bot.textAs(A, text, action(control))
      const running = await prisma.focusSession.findMany({ where: { userId: user.id, state: 'running' } })
      expect(running).toHaveLength(1)
      expect(running[0]!.id).not.toBe(old.id)
      expect(running[0]).toMatchObject({ taskId: null, intentText: null, startedAt: bot.now(), plannedMinutes: 25, plannedEndAt: new Date(bot.now().getTime() + 25 * 60_000) })
      expect(await prisma.focusSession.findUniqueOrThrow({ where: { id: old.id } })).toMatchObject({ state: 'finished', pausedSeconds: 300 })
      expect(await buildSummary(prisma, user, '2026-09-22')).toMatchObject({ totalMinutes: 10 })
      expect(await prisma.outboxMessage.count({ where: { userId: user.id, status: { in: ['pending', 'paused'] }, OR: [{ idempotencyKey: { startsWith: `ping:${old.id}` } }, { idempotencyKey: { startsWith: `session_end:${old.id}` } }] } })).toBe(0)
      if (policy === 1) {
        expect(await prisma.reminderChain.findMany({ where: { userId: user.id, status: 'active', kind: { in: ['work', 'break'] } } })).toMatchObject([{ kind: 'work', sessionId: running[0]!.id }])
      }
      const replies = bot.textsTo(A).slice(before)
      expect(replies).toHaveLength(1)
      expect(replies[0]).toContain('Сессия началась')
      expect(replies[0]).not.toContain('Ты на перерыве')
      const started = running[0]
      bot.advance(1)
      await bot.textAs(A, text, action('focus'))
      expect(await prisma.focusSession.findUniqueOrThrow({ where: { id: started!.id } })).toEqual(started)
      expect(await prisma.focusSession.count({ where: { userId: user.id, state: { in: ['running', 'paused'] } } })).toBe(1)
    }
  })

})
