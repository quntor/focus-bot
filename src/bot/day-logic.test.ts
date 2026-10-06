import { beforeEach, describe, expect, it } from 'vitest'
import { hasDb, prisma, resetDb } from '../test/db.js'
import { makeBot } from '../test/bot.js'
import { runOutboxOnce } from '../outbox/worker.js'
import { reconcile } from '../reminders/store.js'
import { explicitBreakMinutes } from '../session/break-intent.js'
import { beginInput } from './input-lock.js'
import { buildSummary } from './day-flow.js'

const A = 903035
const MIN = 60_000

describe.skipIf(!hasDb)('SBER500-35 day logic', () => {
  beforeEach(resetDb)
  async function setup(now = '2026-10-06T04:50:08Z', migrated = true) {
    const bot = makeBot({ now: new Date(now) })
    bot.ctx.remindersEnabled = true
    if (migrated) bot.ctx.reminderUserIds = [String(A)]
    await bot.onboard(A, '07:50')
    await prisma.user.updateMany({ where: { tgId: BigInt(A) }, data: { timezone: 'Europe/Moscow', morningTime: '08:30', eveningTime: '21:00' } })
    await bot.text(A, 'Начать сессию')
    const user = await prisma.user.findUniqueOrThrow({ where: { tgId: BigInt(A) } })
    const session = await prisma.focusSession.findFirstOrThrow({ where: { userId: user.id, state: 'running' } })
    const task = await prisma.task.create({ data: { userId: user.id, title: 'Стратегия' } })
    await prisma.focusSession.update({ where: { id: session.id }, data: { taskId: task.id, intentText: task.title } })
    return { bot, user, session, task }
  }
  async function summaryFixture(now: string) {
    const bot = makeBot({ now: new Date(now) })
    bot.ctx.remindersEnabled = true
    const user = await prisma.user.create({ data: { tgId: BigInt(A), reminderPolicy: 1, morningTime: '08:30', eveningTime: '21:00' } })
    const message = await prisma.outboxMessage.create({ data: { userId: user.id, kind: 'summary', idempotencyKey: `summary:${user.id}:2026-10-05`, sendAfter: new Date('2026-10-05T18:00:00Z'), payload: { dayKey: '2026-10-05' } } })
    return { bot, user, message }
  }
  it.each(['2026-10-05T18:00:00Z', '2026-10-05T18:00:45Z'])('sends summary in evening slot %s', async now => {
    const f = await summaryFixture(now)
    await runOutboxOnce(f.bot.ctx)
    expect((await prisma.outboxMessage.findUniqueOrThrow({ where: { id: f.message.id } })).status).toBe('sent')
    expect(f.bot.lastText(A)).toContain('Сегодня сессий не было')
  })
  it.each(['quiet', 'disabled', 'blocked', 'proactive', 'pending', 'primary', 'outside'])('preserves summary guard %s', async guard => {
    const f = await summaryFixture(guard === 'outside' ? '2026-10-05T18:01:00Z' : '2026-10-05T18:00:12Z')
    if (guard === 'quiet') await prisma.user.update({ where: { id: f.user.id }, data: { quietUntil: new Date('2026-10-05T21:00:00Z') } })
    if (guard === 'disabled') f.bot.ctx.remindersEnabled = false
    if (guard === 'blocked') await prisma.user.update({ where: { id: f.user.id }, data: { blockedAt: f.bot.now() } })
    if (guard === 'proactive') await prisma.user.update({ where: { id: f.user.id }, data: { proactive: false } })
    if (guard === 'pending') await prisma.user.update({ where: { id: f.user.id }, data: { pendingInput: 'task_add' } })
    if (guard === 'primary') await prisma.reminderChain.create({ data: { userId: f.user.id, kind: 'morning', phaseStartedAt: f.bot.now(), firstDueAt: f.bot.now(), nextDueAt: f.bot.now(), intervalMinutes: 60 } })
    await runOutboxOnce(f.bot.ctx)
    expect(f.bot.tg.sent).toHaveLength(0)
  })
  it('labels delayed summary and excludes current-day session/work from it', async () => {
    const f = await summaryFixture('2026-10-06T05:32:03Z')
    await prisma.focusSession.create({ data: { userId: f.user.id, state: 'finished', startedAt: new Date('2026-10-05T09:00:00Z'), finishedAt: new Date('2026-10-05T09:40:00Z'), outcome: 'done' } })
    await prisma.focusSession.create({ data: { userId: f.user.id, state: 'running', startedAt: new Date('2026-10-06T04:50:08Z'), plannedEndAt: new Date('2026-10-06T05:30:08Z') } })
    await runOutboxOnce(f.bot.ctx)
    expect(f.bot.lastText(A)).toContain('За 05.10.2026: 1 сессия')
    expect(f.bot.lastText(A)).toContain('Фактически в работе: 40 мин.')
    expect(f.bot.lastText(A)).not.toMatch(/сегодня|идёт сейчас|Ещё одна/)
  })
  it.each([true, false])('explicit 90-minute rest survives router invalid and restart, policy1=%s', async migrated => {
    const { bot, user, session, task } = await setup(undefined, migrated)
    expect(session.startedAt).toEqual(bot.now()) // earlier than morning window
    bot.setNow(new Date('2026-10-06T05:32:49Z'))
    bot.ctx.semanticRouterEnabled = true
    bot.ctx.llm = { enabled: true, model: 'test', async complete() { return { text: 'invalid', usage: null } } }
    await bot.text(A, 'Сейчас перерыв полтора часа')
    const paused = await prisma.focusSession.findUniqueOrThrow({ where: { id: session.id } })
    expect(paused).toMatchObject({ state: 'paused', taskId: task.id, plannedRestMinutes: session.plannedRestMinutes, pausedAt: bot.now() })
    expect(bot.lastText(A)).toContain('90 мин')
    expect(bot.lastText(A)).toContain('10:02')
    const restart = makeBot({ now: new Date(bot.now().getTime() + 89 * MIN) })
    restart.ctx.remindersEnabled = true
    await reconcile(restart.ctx)
    await runOutboxOnce(restart.ctx)
    expect(restart.tg.sent).toHaveLength(0)
    restart.advance(1)
    await runOutboxOnce(restart.ctx)
    expect(restart.tg.sent).toHaveLength(1)
    await restart.text(A, 'Вернуться к работе')
    const resumed = await prisma.focusSession.findUniqueOrThrow({ where: { id: session.id } })
    expect(resumed).toMatchObject({ state: 'running', taskId: task.id })
    expect(resumed.plannedEndAt).toEqual(new Date(restart.now().getTime() + session.plannedMinutes! * MIN))
    if (migrated) {
      restart.advance(5)
      await restart.press(A, 'cycle::stop')
      expect(await buildSummary(prisma, user, '2026-10-06')).toMatchObject({ totalMinutes: 47 })
    }
  })
  it.each(['disabled', 'error', 'voice'])('explicit rest is independent of LLM: %s', async mode => {
    const { bot, user, session } = await setup('2026-10-06T07:00:00Z')
    bot.ctx.semanticRouterEnabled = true
    if (mode !== 'disabled') bot.ctx.llm = { enabled: true, model: 'test', async complete() { throw new Error('rest must not call LLM') } }
    if (mode === 'voice') {
      bot.ctx.stt = { enabled: true, model: 'test', async transcribe() { return 'Сейчас перерыв полтора часа' } }
      bot.tg.downloads.set('rest', new Uint8Array([1, 2, 3]))
      await bot.voice(A, { fileId: 'rest', duration: 3, mimeType: 'audio/ogg' })
    } else await bot.text(A, 'Сейчас перерыв полтора часа')
    expect((await prisma.focusSession.findUniqueOrThrow({ where: { id: session.id } })).state).toBe('paused')
    const chain = await prisma.reminderChain.findFirstOrThrow({ where: { userId: user.id, status: 'active' } })
    expect(chain).toMatchObject({ kind: 'break', intervalMinutes: 90, firstDueAt: new Date(bot.now().getTime() + 90 * MIN) })
    expect(await prisma.event.count({ where: { subjectId: user.subjectId, type: 'llm_fallback' } })).toBe(0)
    const deadline = chain.firstDueAt
    bot.advance(1)
    await bot.text(A, 'Сейчас перерыв полтора часа')
    expect((await prisma.reminderChain.findUniqueOrThrow({ where: { id: chain.id } })).firstDueAt).toEqual(deadline)
    expect(await prisma.task.count({ where: { userId: user.id } })).toBe(1)
  })
  it('late voice break cannot mutate pending or session after a newer arrival', async () => {
    const { bot, user, session } = await setup('2026-10-06T07:00:00Z')
    await prisma.user.update({where:{id:user.id},data:{pendingInput:'profile'}})
    bot.ctx.semanticRouterEnabled = true
    bot.ctx.stt = {enabled:true,model:'test',async transcribe() {
      // Simulate a newer arrival while the provider await is completing.
      beginInput(String(A))
      return 'Сейчас перерыв полтора часа'
    }}
    bot.tg.downloads.set('late',new Uint8Array([1,2,3]))
    const chain = await prisma.reminderChain.findFirstOrThrow({where:{userId:user.id,status:'active'}})
    await bot.voice(A,{fileId:'late',duration:3,mimeType:'audio/ogg'})
    expect(await prisma.user.findUniqueOrThrow({where:{id:user.id}})).toMatchObject({pendingInput:'profile'})
    expect(await prisma.focusSession.findUniqueOrThrow({where:{id:session.id}})).toMatchObject({state:'running',pausedAt:null})
    expect(await prisma.reminderChain.findUniqueOrThrow({where:{id:chain.id}})).toMatchObject({kind:'work',revision:chain.revision,nextDueAt:chain.nextDueAt})
    expect(await prisma.workPeriod.count({where:{sessionId:session.id,endedAt:null}})).toBe(1)
  })
  it.each(['running', 'paused', 'idle'])('stop today returns summary and no current-day reminder from %s', async state => {
    const { bot, user, session } = await setup('2026-10-06T07:00:00Z')
    bot.advance(15)
    if (state === 'paused') await bot.text(A, 'Перерыв')
    if (state === 'idle') await prisma.focusSession.update({ where: { id: session.id }, data: { state: 'cancelled', finishedAt: bot.now() } })
    await prisma.outboxMessage.create({ data: { userId: user.id, kind: 'summary', idempotencyKey: `summary:${user.id}:today`, sendAfter: new Date('2026-10-06T18:00:00Z'), payload: { dayKey: '2026-10-06' } } })
    await bot.press(A, 'cycle::stop')
    expect(bot.lastText(A)).toContain('Фактически в работе:')
    expect(bot.lastText(A)).toContain('На сегодня остановились')
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).pendingInput).toBe('none')
    expect(await prisma.reminderChain.count({ where: { userId: user.id, status: 'active' } })).toBe(0)
    expect(await prisma.outboxMessage.count({ where: { userId: user.id, kind: { in: ['summary', 'reminder'] }, status: 'pending' } })).toBe(0)
    bot.advance(800)
    const count = bot.tg.sent.length
    await runOutboxOnce(bot.ctx)
    expect(bot.tg.sent).toHaveLength(count)
  })
})


describe('explicit break command boundary', () => {
  it.each(['Сейчас перерыв полтора часа', 'Беру перерыв на 90 минут', 'Ухожу отдыхать на полтора часа'])('accepts %s', text => {
    expect(explicitBreakMinutes(text)).toBe(90)
  })
  it.each(['Сейчас не перерыв', 'Перерыв не нужен', 'Перерыв через полтора часа', 'Перерыв на полтора часа?', 'Как сделать перерыв?', 'Записать задачу перерыв 90 минут', 'Полтора часа поработаю, потом перерыв', 'Перерыв 0 минут'])('does not mutate for %s', text => {
    expect(explicitBreakMinutes(text)).toBeUndefined()
  })
})
