import { beforeEach, describe, expect, it } from 'vitest'
import { makeBot } from '../test/bot.js'
import { hasDb, prisma, resetDb } from '../test/db.js'
import { sweepOnce } from '../jobs/sweeper.js'
import { runOutboxOnce } from '../outbox/worker.js'
import { clearConversationContext } from './conversation-context.js'
import { enqueue } from '../outbox/queue.js'
import { onMeet } from './day-flow.js'

const A = 54102
const INITIAL = new Date('2026-10-05T07:00:00Z')
const start = { text: 'Начать сессию', route: 'control', action: 'focus', value: null, followUp: null }
const rest = { text: 'Перерыв', route: 'break', minutes: null, durationSource: null, followUp: null }

describe.skipIf(!hasDb)('SBER500-41 contextual invitations across both policies', () => {
  beforeEach(resetDb)
  async function setup(policy: number, preparing = false) {
    const bot = makeBot({ now: INITIAL })
    bot.ctx.remindersEnabled = true
    if (policy === 1) bot.ctx.reminderUserIds = [String(A)]
    await bot.setupOnboarded(A)
    const user = await prisma.user.findUniqueOrThrow({ where: { tgId: BigInt(A) } })
    if (!preparing) await prisma.focusSession.deleteMany({ where: { userId: user.id } })
    await prisma.user.update({ where: { id: user.id }, data: { pendingInput: 'none', reminderPolicy: policy } })
    return { bot, user }
  }
  it.each([0, 1])('policy %s: explicit idle rest survives context loss and does not invite tomorrow', async policy => {
    const { bot, user } = await setup(policy)
    await bot.textAs(A, 'Перерыв', rest)
    const afterRest = bot.textsTo(A).length
    clearConversationContext()
    bot.advance(1440)
    await sweepOnce(bot.ctx)
    await runOutboxOnce(bot.ctx)
    expect(bot.textsTo(A).slice(afterRest)).toEqual([])
    expect(await prisma.focusSession.count({ where: { userId: user.id } })).toBe(0)
    await bot.textAs(A, 'Начать сессию', start)
    expect(await prisma.focusSession.count({ where: { userId: user.id, state: 'running' } })).toBe(1)
    expect(await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).toMatchObject({ idleRestAt: null })
  })
  it.each([0, 1])('policy %s: cancelling preparation for rest never resurrects morning', async policy => {
    const { bot, user } = await setup(policy, true)
    await bot.textAs(A, 'Перерыв', rest)
    const count = bot.textsTo(A).length
    await sweepOnce(bot.ctx)
    await runOutboxOnce(bot.ctx)
    expect(bot.textsTo(A).slice(count)).toEqual([])
    expect(await prisma.focusSession.count({ where: { userId: user.id, state: 'running' } })).toBe(0)
    expect(await prisma.calendarPlan.count({ where: { userId: user.id } })).toBe(0)
  })
  it('finished real work today suppresses morning even without calendar plan', async () => {
    const { bot, user } = await setup(1)
    await prisma.focusSession.create({ data: { userId: user.id, state: 'finished', startedAt: new Date(INITIAL.getTime() - 60_000), finishedAt: INITIAL } })
    const count = bot.textsTo(A).length
    await sweepOnce(bot.ctx)
    await runOutboxOnce(bot.ctx)
    expect(bot.textsTo(A).slice(count)).toEqual([])
  })
  it('quick start with existing tasks produces exactly one confirmation', async () => {
    const { bot, user } = await setup(1)
    await prisma.task.create({ data: { userId: user.id, title: 'SEO Милавицы' } })
    const count = bot.textsTo(A).length
    await bot.textAs(A, 'Начать сессию', start)
    expect(bot.textsTo(A).slice(count)).toHaveLength(1)
    expect(bot.lastText(A)).toContain('Сессия началась')
  })
  it.each([0, 1])('policy %s: explicit night meeting survives idle rest and keeps its agreed time', async policy => {
    const { bot, user } = await setup(policy)
    await bot.textAs(A, 'Перерыв', rest)
    bot.setNow(new Date('2026-10-05T20:00:00Z')) // 23:00 Moscow, outside auto window
    await enqueue(prisma, { userId: user.id, kind: 'meeting', key: `night:${policy}`, sendAfter: bot.now(), payload: { defaulted: false, morning: false } })
    const before = bot.textsTo(A).length
    await runOutboxOnce(bot.ctx)
    expect(bot.textsTo(A).slice(before)).toEqual(['Время, о котором договорились. Готов начать?'])
    expect(await prisma.focusSession.count({ where: { userId: user.id } })).toBe(0)
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).idleRestAt).not.toBeNull()
  })
  it.each([0, 1])('policy %s: reading status/tasks/help and a failed start do not end idle rest', async policy => {
    const { bot, user } = await setup(policy)
    await bot.textAs(A, 'Перерыв', rest)
    const resting = await prisma.user.findUniqueOrThrow({ where: { id: user.id } })
    for (const action of ['status', 'tasks', 'help']) {
      await bot.textAs(A, action, { text: action, route: 'control', action, value: null, followUp: null })
    }
    bot.ctx.llm = { enabled: true, model: 'test', async complete() { throw new Error('offline') } }
    await bot.text(A, 'Начать сессию')
    expect(await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).toMatchObject({ idleRestAt: resting.idleRestAt })
    expect(await prisma.focusSession.count({ where: { userId: user.id, state: 'running' } })).toBe(0)
  })
  it('a legacy invitation waits for the current question and never erases it', async () => {
    const { bot, user } = await setup(0)
    await prisma.user.update({ where: { id: user.id }, data: { pendingInput: 'meeting_time' } })
    await enqueue(prisma, { userId: user.id, kind: 'meeting', key: 'decision', sendAfter: bot.now(), payload: { defaulted: false, morning: false } })
    const before = bot.textsTo(A).length
    await runOutboxOnce(bot.ctx)
    expect(bot.textsTo(A).slice(before)).toEqual([])
    expect(await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).toMatchObject({ pendingInput: 'meeting_time' })
    await prisma.user.update({ where: { id: user.id }, data: { pendingInput: 'none' } })
    bot.advance(1)
    await runOutboxOnce(bot.ctx)
    expect(bot.textsTo(A).slice(before)).toHaveLength(1)
  })
  it.each([0, 1])('policy %s: idle rest does not receive an empty evening summary', async policy => {
    const { bot, user } = await setup(policy)
    await bot.textAs(A, 'Перерыв', rest)
    bot.setNow(new Date('2026-10-05T18:00:00Z'))
    await enqueue(prisma, { userId: user.id, kind: 'summary', key: `empty-summary:${policy}`, sendAfter: bot.now(), payload: { dayKey: '2026-10-05' } })
    const before = bot.textsTo(A).length
    await runOutboxOnce(bot.ctx)
    expect(bot.textsTo(A).slice(before)).toEqual([])
  })
  it('a policy1 morning appointment made during idle rest arrives once, without a rival chain', async () => {
    const { bot, user } = await setup(1)
    await bot.textAs(A, 'Перерыв', rest)
    const current = await prisma.user.findUniqueOrThrow({ where: { id: user.id } })
    await onMeet({ ...bot.ctx, inputUserId: user.id }, current, 'morning')
    bot.advance(1440)
    const before = bot.textsTo(A).length
    await sweepOnce(bot.ctx)
    await runOutboxOnce(bot.ctx)
    expect(bot.textsTo(A).slice(before)).toEqual(['Время, о котором договорились. Готов начать?'])
    expect(await prisma.reminderChain.count({ where: { userId: user.id, status: 'active', kind: 'morning' } })).toBe(0)
  })
  it('an explicit morning appointment resolves today, without a second automatic invitation', async () => {
    const { bot, user } = await setup(1)
    await onMeet({ ...bot.ctx, inputUserId: user.id }, user, 'morning')
    bot.advance(1440)
    const before = bot.textsTo(A).length
    await sweepOnce(bot.ctx)
    await runOutboxOnce(bot.ctx)
    await sweepOnce(bot.ctx)
    await runOutboxOnce(bot.ctx)
    expect(bot.textsTo(A).slice(before)).toEqual(['Время, о котором договорились. Готов начать?'])
    const chain = await prisma.reminderChain.findFirstOrThrow({ where: { userId: user.id, kind: 'morning', status: 'active' } })
    expect(chain.nextDueAt.getTime()).toBeGreaterThan(bot.now().getTime())
  })
})
