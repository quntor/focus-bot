import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeBot } from '../test/bot.js'
import { hasDb, prisma, resetDb } from '../test/db.js'
import { T } from './texts.js'
import { cb } from './callbacks.js'
import { routeSemanticInput } from './semantic-routing.js'
import type { LlmRequest } from '../llm/provider.js'
import type { Prisma } from '@prisma/client'

const A = 903041
async function product(userId: string) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } })
  return { pending: user.pendingInput, profile: user.profileText, policy: user.reminderPolicy,
    sessions: await prisma.focusSession.findMany({ where: { userId } }),
    tasks: await prisma.task.findMany({ where: { userId } }),
    outbox: await prisma.outboxMessage.findMany({ where: { userId } }),
    chains: await prisma.reminderChain.findMany({ where: { userId } }),
    periods: await prisma.workPeriod.findMany({ where: { session: { userId } } }) }
}
function model(route: object) { return { enabled: true, model: 'test', complete: vi.fn(async () => ({ text: JSON.stringify(route), usage: null })) } }
describe.skipIf(!hasDb)('every text is LLM-first', () => {
  beforeEach(resetDb)
  it.each(['/start', '/status', '/guide', '/focus Сделать отчёт', T.sessionStartButton, T.sessionBreakButton, T.sessionResumeButton, '2', '10:00', 'Идиот!', 'отдых 40 минут'])('%s reaches model before any action', async text => {
    const llm = model({ route: 'feedback', text, followUp: null })
    const bot = makeBot({ llm }) // flag false may not restore a text bypass
    const user = await prisma.user.create({ data: { tgId: BigInt(A), pendingInput: 'profile' } })
    const before = await product(user.id)
    await bot.text(A, text)
    expect(llm.complete).toHaveBeenCalledTimes(1)
    expect(await product(user.id)).toEqual(before)
    expect(bot.lastText(A)).toBe(T.feedback)
  })
  it('the first message is also interpreted, not forced into onboarding', async () => {
    const llm = model({ route: 'feedback', text: 'Идиот!', followUp: null })
    const bot = makeBot({ llm })
    await bot.text(A, 'Идиот!')
    expect(llm.complete).toHaveBeenCalledTimes(1)
    expect(bot.lastText(A)).toBe(T.feedback)
    expect((await prisma.user.findUniqueOrThrow({ where: { tgId: BigInt(A) } })).pendingInput).toBe('none')
  })
  it.each(['disabled', 'error', 'invalid'] as const)('%s fails closed, never saves raw input', async mode => {
    const llm = model({ route: 'nonsense' })
    llm.enabled = mode !== 'disabled'
    if (mode === 'error') llm.complete.mockImplementation(async () => { throw new Error('failed') })
    const bot = makeBot({ llm })
    const user = await prisma.user.create({ data: { tgId: BigInt(A), pendingInput: 'task_add' } })
    const before = await product(user.id)
    await bot.text(A, 'Идиот!')
    expect(await product(user.id)).toEqual(before)
    expect(bot.lastText(A)).toBe(T.cannotInterpret)
  })
  it('LLM can choose break with a duration without any keyword parser', async () => {
    const text = 'Устрою себе сорокаминутную передышку'
    const llm = model({ route: 'break', text, minutes: 40, durationSource: 'сорокаминутную', followUp: null })
    const bot = makeBot({ llm, now: new Date('2026-10-07T10:54:31Z') })
    const user = await prisma.user.create({ data: { tgId: BigInt(A), timezone: 'Europe/Moscow' } })
    const session = await prisma.focusSession.create({ data: { userId: user.id, state: 'running', startedAt: bot.now(), plannedMinutes: 40, plannedEndAt: new Date(bot.now().getTime() + 40 * 60_000) } })
    await bot.text(A, text)
    expect((await prisma.focusSession.findUniqueOrThrow({ where: { id: session.id } })).state).toBe('paused')
    expect(bot.lastText(A)).toContain('40 мин')
    bot.advance(1)
    llm.complete.mockResolvedValue({ text: JSON.stringify({ route: 'break', text: 'отдых 90 минут', minutes: 90, durationSource: '90 минут', followUp: null }), usage: null })
    await bot.text(A, 'отдых 90 минут')
    const paused = await prisma.focusSession.findUniqueOrThrow({ where: { id: session.id } })
    expect(paused.state).toBe('paused')
    expect(paused.pausedAt).toEqual(new Date('2026-10-07T10:54:31Z'))
    expect(bot.lastText(A)).toContain('15:24')
  })
  it.each([
    { state: 'collecting_intent', text: 'Начну с плана', answer: { route: 'intent_step', text: 'Начну с плана', title: 'Составить план', minutes: null, durationSource: null, followUp: null }, minutes: 60 },
    { state: 'running', text: 'Составить план за 25 минут', answer: { route: 'new_task', text: 'Составить план за 25 минут', intent: { task: 't1', title: 'Составить план', scope: 'multi_session' }, minutes: 25, durationSource: '25 минут', followUp: null }, minutes: 25 },
  ] as const)('$state preserves a relevant parent outside both twenty-task pools', async ({ state, text, answer, minutes }) => {
    const bot = makeBot()
    const user = await prisma.user.create({ data: { tgId: BigInt(A), timezone: 'Europe/Moscow' } })
    await prisma.task.createMany({ data: Array.from({ length: 21 }, (_, i) => ({ userId: user.id, title: `Старая работа ${i}`, createdAt: new Date('2026-09-01T00:00:00Z'), lastSessionAt: new Date('2026-09-20T00:00:00Z') })) })
    const parent = await prisma.task.create({ data: { userId: user.id, title: 'Большой проект', createdAt: new Date('2026-09-10T00:00:00Z'), lastSessionAt: new Date('2026-09-10T00:00:00Z'), sessionsCount: state === 'running' ? 1 : 0 } })
    await prisma.task.createMany({ data: Array.from({ length: 21 }, (_, i) => ({ userId: user.id, title: `Новая работа ${i}`, createdAt: new Date('2026-09-15T00:00:00Z'), lastSessionAt: new Date('2026-09-21T00:00:00Z') })) })
    const session = await prisma.focusSession.create({ data: { userId: user.id, state, taskId: parent.id, intentText: parent.title, scope: 'multi_session', plannedMinutes: 60, minutesSource: 'user', ...(state === 'running' ? { startedAt: bot.now(), plannedEndAt: new Date(bot.now().getTime() + 60 * 60_000) } : {}) } })
    const complete = vi.fn(async (request: LlmRequest) => {
      const input = JSON.parse(request.input)
      expect(input.text).toBe(text)
      expect(input.tasks).toHaveLength(20)
      expect(input.tasks[0]).toMatchObject({ label: 't1', title: parent.title })
      expect(input.session).toMatchObject({ task: 't1', scope: 'multi_session' })
      return { text: JSON.stringify(answer), usage: null }
    })
    bot.ctx.llm = { enabled: true, model: 'test', complete }
    await bot.text(A, text)
    expect(complete).toHaveBeenCalledTimes(1)
    expect(await prisma.focusSession.findUniqueOrThrow({ where: { id: session.id } })).toMatchObject({ taskId: parent.id, intentText: 'Составить план', scope: 'multi_session', plannedMinutes: minutes, minutesSource: 'user' })
    expect(await prisma.task.count({ where: { userId: user.id } })).toBe(43)
    expect(await prisma.task.findUniqueOrThrow({ where: { id: parent.id } })).toMatchObject({ title: parent.title, sessionsCount: state === 'running' ? 1 : 0 })
  })
  it.each([
    { history: 'unassigned', idle: false, minutes: 30, source: 'полчаса' },
    { history: 'unassigned', idle: false, minutes: null, source: null },
    { history: 'old', idle: false, minutes: 30, source: 'полчаса' },
    { history: 'none', idle: true, minutes: 30, source: 'полчаса' },
    { history: 'none', idle: false, minutes: 30, source: 'полчаса' },
  ] as const)('LLM can start unassigned work after $history / idle=$idle / minutes=$minutes', async ({ history, idle, minutes, source }) => {
    const text = minutes === null ? 'Ещё поработаю' : 'Ещё полчаса поработаю'
    const bot = makeBot({ now: new Date('2026-10-09T15:01:34Z') })
    bot.ctx.remindersEnabled = true
    bot.ctx.reminderUserIds = [String(A)]
    const quietUntil = new Date('2026-10-09T21:00:00Z')
    const user = await prisma.user.create({ data: { tgId: BigInt(A), timezone: 'Europe/Moscow', technique: 'pomodoro', reminderPolicy: 1, quietUntil, idleRestAt: idle ? bot.now() : null } })
    const previous = history === 'none' ? null : await prisma.focusSession.create({ data: {
      userId: user.id, state: 'finished', reminderPolicy: 1, intentText: null, taskId: null,
      startedAt: new Date(bot.now().getTime() - (history === 'old' ? 300 : 120) * 60_000), finishedAt: new Date(bot.now().getTime() - (history === 'old' ? 181 : 1) * 60_000), plannedMinutes: 90,
    } })
    const complete = vi.fn(async (request: LlmRequest) => {
      const input = JSON.parse(request.input)
      expect(input.text).toBe(text)
      expect(input.session).toBeNull()
      expect(input.allowedRoutes).toContain('continue_same')
      expect(input.quietUntil).toBe(quietUntil.toISOString())
      expect(input.idleRestAt).toBe(idle ? bot.now().toISOString() : null)
      return { text: JSON.stringify({ route: 'continue_same', text, minutes, durationSource: source, followUp: null }), usage: null }
    })
    bot.ctx.llm = { enabled: true, model: 'test', complete }
    await bot.text(A, text)
    expect(complete).toHaveBeenCalledTimes(1)
    const running = await prisma.focusSession.findFirstOrThrow({ where: { userId: user.id, state: 'running' } })
    expect(running).toMatchObject({ taskId: null, intentText: null, plannedMinutes: minutes ?? 25, minutesSource: minutes === null ? 'bot' : 'user', startedAt: bot.now(), plannedEndAt: new Date(bot.now().getTime() + (minutes ?? 25) * 60_000) })
    expect(await prisma.task.count({ where: { userId: user.id } })).toBe(0)
    expect(await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).toMatchObject({ idleRestAt: null, quietUntil, pendingInput: 'none' })
    if (previous) expect(await prisma.focusSession.findUniqueOrThrow({ where: { id: previous.id } })).toEqual(previous)
    expect(await prisma.workPeriod.count({ where: { sessionId: running.id, endedAt: null } })).toBe(1)
    expect(await prisma.reminderChain.findFirstOrThrow({ where: { userId: user.id, status: 'active' } })).toMatchObject({ kind: 'work', sessionId: running.id, firstDueAt: running.plannedEndAt })
    expect(bot.textsTo(A)).toHaveLength(1)
    expect(bot.lastText(A)).not.toContain('Отдыхай')
    expect(bot.lastText(A)).toContain('напоминания остаются выключены')
    expect(bot.lastText(A)).not.toContain('напишу в')
  })
  it('stop day → LLM-selected work starts a fresh thirty-minute timer without altering ninety minutes', async () => {
    const bot = makeBot({ now: new Date('2026-10-09T13:30:00Z') })
    bot.ctx.remindersEnabled = true
    bot.ctx.reminderUserIds = [String(A)]
    const user = await prisma.user.create({ data: { tgId: BigInt(A), timezone: 'Europe/Moscow', technique: 'pomodoro', reminderPolicy: 1 } })
    await bot.textAs(A, 'Начать сессию', { route: 'control', text: 'Начать сессию', action: 'focus', value: null, followUp: null })
    const original = await prisma.focusSession.findFirstOrThrow({ where: { userId: user.id, state: 'running' } })
    bot.advance(90)
    await bot.press(A, cb('cycle', null, 'stop'))
    expect(bot.lastText(A)).toContain('На сегодня остановились')
    const saved = await prisma.focusSession.findUniqueOrThrow({ where: { id: original.id } })
    const periods = await prisma.workPeriod.findMany({ where: { sessionId: original.id } })
    expect(saved).toMatchObject({ state: 'finished', outcome: null, taskId: null })
    expect(periods).toHaveLength(1)
    expect((periods[0]!.endedAt!.getTime() - periods[0]!.startedAt.getTime()) / 60_000).toBe(90)
    const text = 'Ещё полчаса поработаю'
    await bot.textAs(A, text, { route: 'continue_same', text, minutes: 30, durationSource: 'полчаса', followUp: null })
    const started = await prisma.focusSession.findFirstOrThrow({ where: { userId: user.id, state: 'running' } })
    expect(started).toMatchObject({ plannedMinutes: 30, minutesSource: 'user', taskId: null, intentText: null, startedAt: bot.now(), plannedEndAt: new Date(bot.now().getTime() + 30 * 60_000) })
    expect(await prisma.focusSession.findUniqueOrThrow({ where: { id: original.id } })).toEqual(saved)
    expect(await prisma.workPeriod.findMany({ where: { sessionId: original.id } })).toEqual(periods)
    expect(await prisma.task.count({ where: { userId: user.id } })).toBe(0)
    expect(bot.lastText(A)).toContain('30')
    expect(bot.lastText(A)).not.toContain('Отдыхай')
    expect(bot.lastText(A)).toContain('напоминания остаются выключены')
    expect(bot.lastText(A)).not.toContain('напишу в')
  })
  it('a stale transactional snapshot closes neither the day nor the requested meeting', async () => {
    const text = 'Закрыть день и встретиться завтра в 10:00'
    const llm = model({ route: 'schedule_meeting', text, hour: 10, minute: 0, day: 'tomorrow', closeDay: true, followUp: null })
    const bot = makeBot({ llm })
    const user = await prisma.user.create({ data: { tgId: BigInt(A), timezone: 'Europe/Moscow' } })
    await prisma.focusSession.create({ data: { userId: user.id, state: 'running', startedAt: bot.now(), plannedMinutes: 25, plannedEndAt: new Date(bot.now().getTime() + 25 * 60_000) } })
    const before = await product(user.id)
    let transactionalReads = 0
    // Simulate a different pending state becoming visible only after ingress
    // has checked its snapshot, when the close-day transaction rechecks it.
    const db = new Proxy(prisma, { get(target, key) {
      if (key !== '$transaction') return Reflect.get(target, key)
      return (work: (tx: Prisma.TransactionClient) => Promise<unknown>) => target.$transaction(async tx => work(new Proxy(tx, { get(transaction, entity) {
        const delegate = Reflect.get(transaction, entity)
        if (entity !== 'user') return delegate
        return new Proxy(delegate, { get(object, operation) {
          const original = Reflect.get(object, operation)
          if (operation !== 'findUnique') return original
          return async (...args: unknown[]) => {
            const value = await original.apply(object, args)
            transactionalReads++
            return value ? { ...value, pendingInput: 'profile' } : value
          }
        } })
      } })))
    } })
    await routeSemanticInput({ ...bot.ctx, db, inputUserId: user.id, semanticRouterEnabled: true, isCurrentInput: () => true }, user, text, 'text', null, async () => {})
    expect(transactionalReads).toBeGreaterThan(0)
    expect(llm.complete).toHaveBeenCalledTimes(1)
    expect(bot.lastText(A)).toBe(T.stale)
    expect(await product(user.id)).toEqual(before)
    expect(await prisma.dailyGoal.count({ where: { userId: user.id } })).toBe(0)
    expect(await prisma.event.count({ where: { subjectId: user.subjectId, type: { in: ['day_closed', 'meeting_scheduled'] } } })).toBe(0)
  })
})
