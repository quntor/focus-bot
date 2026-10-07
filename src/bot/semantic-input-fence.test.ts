import { beforeEach, describe, expect, it } from 'vitest'
import { makeBot } from '../test/bot.js'
import { hasDb, prisma, resetDb } from '../test/db.js'
import { onIntentText, onResume, onContinueChoice, onRunningWorkText } from './session-flow.js'
import { routeSemanticInput } from './semantic-routing.js'
import { onReminderAction } from '../reminders/actions.js'
import { releasePending } from '../tg/webhook.js'
import type { Ctx } from './context.js'

// A real DB await completing after the arrival fence changes must not commit.
function invalidateAfter(ctx: Ctx, model: 'focusSession' | 'task' | 'user' | 'dailyGoal', method: string) {
  let current = true
  const db = new Proxy(ctx.db, {
    get(target, key) {
      if (key !== '$transaction') return Reflect.get(target, key)
      return (work: (tx: unknown) => Promise<unknown>) => target.$transaction(async (tx) => work(new Proxy(tx, {
        get(transaction, entity) {
          const delegate = Reflect.get(transaction, entity)
          if (entity !== model) return delegate
          return new Proxy(delegate, {
            get(object, operation) {
              const original = Reflect.get(object, operation)
              if (operation !== method) return original
              return async (...args: unknown[]) => {
                const value = await original.apply(object, args)
                current = false
                return value
              }
            },
          })
        },
      })))
    },
  })
  return { ...ctx, db, semanticRouterEnabled: true, isCurrentInput: () => current }
}

describe.skipIf(!hasDb)('semantic mutation arrival fence across DB awaits', () => {
  beforeEach(resetDb)
  async function ready() {
    const bot = makeBot()
    await bot.setupOnboarded(50301)
    const user = await prisma.user.findUniqueOrThrow({ where: { tgId: 50301n } })
    await prisma.focusSession.deleteMany({ where: { userId: user.id } })
    return { bot, user }
  }
  it('collecting creation rolls back when superseded during INSERT', async () => {
    const { bot, user } = await ready()
    const ctx = invalidateAfter(bot.ctx, 'focusSession', 'create')
    await expect(onIntentText(ctx, user, 'Письма за 15 минут', { taskId: null, title: 'Письма', scope: 'step', minutes: 15, llmUsed: true })).rejects.toThrow()
    expect(await prisma.focusSession.count()).toBe(0)
    expect(await prisma.task.count()).toBe(0)
  })
  it('intent and named timer do not commit when superseded during UPDATE', async () => {
    const { bot, user } = await ready()
    const session = await prisma.focusSession.create({ data: { userId: user.id, state: 'collecting_intent' } })
    await onIntentText(invalidateAfter(bot.ctx, 'focusSession', 'updateMany'), user, 'Письма за 15 минут', { taskId: null, title: 'Письма', scope: 'step', minutes: 15, llmUsed: true })
    expect(await prisma.focusSession.findUniqueOrThrow({ where: { id: session.id } })).toMatchObject({ state: 'collecting_intent', intentText: null, plannedMinutes: null })
    expect(await prisma.task.count()).toBe(0)
    expect(await prisma.outboxMessage.count({ where: { kind: 'session_end' } })).toBe(0)
  })
  it('resume rolls back state and outbox when superseded during UPDATE', async () => {
    const { bot, user } = await ready()
    const session = await prisma.focusSession.create({ data: { userId: user.id, state: 'paused', pausedAt: bot.ctx.now(), startedAt: bot.ctx.now(), plannedMinutes: 25 } })
    await onResume(invalidateAfter(bot.ctx, 'focusSession', 'updateMany'), user)
    expect(await prisma.focusSession.findUniqueOrThrow({ where: { id: session.id } })).toMatchObject({ state: 'paused' })
    expect(await prisma.outboxMessage.count({ where: { kind: 'session_end' } })).toBe(0)
  })
  it('continuation claim and new session roll back together', async () => {
    const { bot, user } = await ready()
    const task = await prisma.task.create({ data: { userId: user.id, title: 'Письма' } })
    const old = await prisma.focusSession.create({ data: { userId: user.id, state: 'finished', taskId: task.id, continueSuggested: true, plannedMinutes: 15 } })
    await onContinueChoice(invalidateAfter(bot.ctx, 'focusSession', 'create'), user, old.id, 'same', { change: async () => {} })
    expect(await prisma.focusSession.findUniqueOrThrow({ where: { id: old.id } })).toMatchObject({ restChoice: null })
    expect(await prisma.focusSession.count()).toBe(1)
  })
  it('capture rolls back tasks when superseded during INSERT', async () => {
    const { bot, user } = await ready()
    const ctx = invalidateAfter(bot.ctx, 'task', 'create')
    ctx.llm = { enabled: true, model: 'test', complete: async () => ({ text: JSON.stringify({ route: 'capture', text: 'Запиши письма', titles: ['Письма'], followUp: null }), usage: null }) }
    await routeSemanticInput(ctx, user, 'Запиши письма', 'text', null, async () => {})
    expect(await prisma.task.count()).toBe(0)
  })
  it('day close rolls back summary and pending when superseded during writes', async () => {
    const { bot, user } = await ready()
    const ctx = invalidateAfter(bot.ctx, 'dailyGoal', 'upsert')
    ctx.llm = { enabled: true, model: 'test', complete: async () => ({ text: JSON.stringify({ route: 'close_day', text: 'Всё на сегодня', followUp: null }), usage: null }) }
    await routeSemanticInput(ctx, user, 'Всё на сегодня', 'text', null, async () => {})
    expect(await prisma.dailyGoal.count({ where: { summarySentAt: { not: null } } })).toBe(0)
    expect(await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).toMatchObject({ pendingInput: user.pendingInput })
  })
  it('pending release rolls back when superseded during UPDATE', async () => {
    const { bot, user } = await ready()
    await prisma.user.update({ where: { id: user.id }, data: { pendingInput: 'profile' } })
    const fresh = await prisma.user.findUniqueOrThrow({ where: { id: user.id } })
    const ctx = invalidateAfter(bot.ctx, 'user', 'updateMany')
    ctx.llm = { enabled: true, model: 'test', complete: async () => ({ text: JSON.stringify({ route: 'capture', text: 'Запиши письма', titles: ['Письма'], followUp: null }), usage: null }) }
    await routeSemanticInput(ctx, fresh, 'Запиши письма', 'text', null, async () => {})
    expect(await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).toMatchObject({ pendingInput: 'profile' })
    expect(await prisma.task.count()).toBe(0)
  })
  it('a delayed pending-work parser cannot replace work or consume pending', async () => {
    const { bot, user } = await ready()
    const task = await prisma.task.create({ data: { userId: user.id, title: 'Старая работа' } })
    const session = await prisma.focusSession.create({ data: { userId: user.id, state: 'running', taskId: task.id, intentText: task.title, startedAt: bot.ctx.now() } })
    await prisma.user.update({ where: { id: user.id }, data: { pendingInput: `running_work:${session.id}` } })
    const fresh = await prisma.user.findUniqueOrThrow({ where: { id: user.id } })
    let current = true
    const ctx = { ...bot.ctx, semanticRouterEnabled: true, isCurrentInput: () => current,
      llm: { enabled: true, model: 'test', complete: async () => {
        current = false
        return { text: JSON.stringify({ task_id: null, title: 'Новая работа', scope: 'step' }), usage: null }
      } },
    }
    await expect(onRunningWorkText(ctx, fresh, session.id, 'Новая работа')).rejects.toThrow()
    expect(await prisma.focusSession.findUniqueOrThrow({ where: { id: session.id } })).toMatchObject({ taskId: task.id, intentText: task.title })
    expect(await prisma.task.count()).toBe(1)
    expect(await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).toMatchObject({ pendingInput: fresh.pendingInput })
  })
  it('explicit pause rolls back period and chain when superseded during UPDATE', async () => {
    const { bot, user } = await ready()
    const session = await prisma.focusSession.create({data:{userId:user.id,state:'running',reminderPolicy:1,plannedMinutes:40,startedAt:bot.now()}})
    const chain = await prisma.reminderChain.create({data:{userId:user.id,sessionId:session.id,kind:'work',phaseStartedAt:bot.now(),firstDueAt:bot.now(),nextDueAt:bot.now(),intervalMinutes:40}})
    await prisma.workPeriod.create({data:{sessionId:session.id,startedAt:bot.now()}})
    await onReminderAction(invalidateAfter(bot.ctx,'focusSession','update'),user,null,'break',{restMinutes:90})
    expect(await prisma.focusSession.findUniqueOrThrow({where:{id:session.id}})).toMatchObject({state:'running',pausedAt:null})
    expect(await prisma.workPeriod.count({where:{sessionId:session.id,endedAt:null}})).toBe(1)
    expect(await prisma.reminderChain.findUniqueOrThrow({where:{id:chain.id}})).toMatchObject({status:'active',kind:'work',revision:chain.revision})
    expect(await prisma.reminderChain.count({where:{kind:'break'}})).toBe(0)
  })
  it('explicit pending release rolls back candidate and pending during UPDATE', async () => {
    const { bot, user } = await ready()
    const session = await prisma.focusSession.create({data:{userId:user.id,state:'running',pendingTaskTitle:'Кандидат'}})
    const pendingInput = `running_task_choice:${session.id}:1234abcd`
    const fresh = await prisma.user.update({where:{id:user.id},data:{pendingInput}})
    await expect(releasePending(invalidateAfter(bot.ctx,'user','updateMany'),fresh,true)).rejects.toThrow()
    expect(await prisma.user.findUniqueOrThrow({where:{id:user.id}})).toMatchObject({pendingInput})
    expect(await prisma.focusSession.findUniqueOrThrow({where:{id:session.id}})).toMatchObject({pendingTaskTitle:'Кандидат'})
  })
  it('flag-off ignores arrival fencing and preserves named-time legacy start', async () => {
    const { bot, user } = await ready()
    const ctx = { ...invalidateAfter(bot.ctx, 'focusSession', 'updateMany'), semanticRouterEnabled: false }
    await onIntentText(ctx, user, 'Письма за 15 минут', { taskId: null, title: 'Письма', scope: 'step', minutes: 15, llmUsed: true })
    expect(await prisma.focusSession.findFirstOrThrow({ where: { userId: user.id } })).toMatchObject({ state: 'running', intentText: 'Письма', plannedMinutes: 15 })
  })
  it('capture rechecks arrival after the transaction snapshot await', async () => {
    const { bot, user } = await ready()
    const ctx = invalidateAfter(bot.ctx, 'task', 'findMany')
    ctx.llm = { enabled: true, model: 'test', complete: async () => ({ text: JSON.stringify({ route: 'capture', text: 'Запиши письма', titles: ['Письма'], followUp: null }), usage: null }) }
    await routeSemanticInput(ctx, user, 'Запиши письма', 'text', null, async () => {})
    expect(await prisma.task.count()).toBe(0)
  })
})
