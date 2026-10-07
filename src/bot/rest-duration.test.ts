import { beforeEach, describe, expect, it } from 'vitest'
import { hasDb, prisma, resetDb } from '../test/db.js'
import { makeBot } from '../test/bot.js'
import { scriptedModel, rest } from '../test/semantic-provider.js'
import { reconcile, replaceChain } from '../reminders/store.js'
import { runOutboxOnce } from '../outbox/worker.js'
const A = 903039
const MIN = 60_000

describe.skipIf(!hasDb)('model-selected rest preserves the real timer', () => {
  beforeEach(resetDb)
  it.each([0, 1] as const)('break correction text/voice and restart, reminder policy %s', async policy => {
    const model = scriptedModel()
    const bot = makeBot({ now: new Date('2026-10-07T10:54:31Z'), llm: model.provider })
    bot.ctx.remindersEnabled = true
    const user = await prisma.user.create({ data: { tgId: BigInt(A), timezone: 'Europe/Moscow', reminderPolicy: policy, proactive: false, pingsEnabled: false } })
    const task = await prisma.task.create({ data: { userId: user.id, title: 'Митинг с командой' } })
    const startedAt = new Date('2026-10-07T09:38:19Z')
    const session = await prisma.focusSession.create({ data: { userId: user.id, reminderPolicy: policy, taskId: task.id, intentText: task.title, state: 'running', startedAt, plannedMinutes: 40, plannedRestMinutes: 10, plannedEndAt: bot.now() } })
    if (policy === 1) await prisma.$transaction(async tx => {
      await tx.workPeriod.create({ data: { sessionId: session.id, startedAt } })
      await replaceChain(tx, user, 'work', session, startedAt, 40)
    })
    model.enqueue('Перерыв', rest('Перерыв'))
    await bot.text(A, 'Перерыв')
    const pauseAt = bot.now()
    const paused = await prisma.focusSession.findUniqueOrThrow({ where: { id: session.id } })
    const periods = await prisma.workPeriod.findMany({ where: { sessionId: session.id } })
    bot.setNow(new Date('2026-10-07T10:54:46Z'))
    model.enqueue('отдых 40 минут', rest('отдых 40 минут', 40, '40 минут'))
    await bot.text(A, 'отдых 40 минут')
    expect(bot.lastText(A)).toContain('14:34')
    expect(await prisma.focusSession.findUniqueOrThrow({ where: { id: session.id } })).toEqual(paused)
    expect(await prisma.workPeriod.findMany({ where: { sessionId: session.id } })).toEqual(periods)
    model.enqueue('Идиот!', { route: 'feedback', text: 'Идиот!', followUp: null })
    await bot.text(A, 'Идиот!')
    expect(bot.lastText(A)).toContain('не меняю')
    model.enqueue('Отдохну полтора часа', rest('Отдохну полтора часа', 90, 'полтора часа'))
    bot.ctx.stt = { enabled: true, model: 'test', async transcribe() { return 'Отдохну полтора часа' } }
    bot.tg.downloads.set('rest90', new Uint8Array([1, 2, 3]))
    await bot.voice(A, { fileId: 'rest90', duration: 3 })
    expect(bot.lastText(A)).toContain('15:24')
    expect(await prisma.focusSession.findUniqueOrThrow({ where: { id: session.id } })).toEqual(paused)
    const deadline = new Date(pauseAt.getTime() + 90 * MIN)
    if (policy === 1) expect(await prisma.reminderChain.findFirstOrThrow({ where: { userId: user.id, status: 'active' } })).toMatchObject({ kind: 'break', firstDueAt: deadline })
    else expect(await prisma.outboxMessage.findFirstOrThrow({ where: { userId: user.id, kind: 'break_over', status: 'pending' } })).toMatchObject({ sendAfter: deadline })
    model.enqueue('Отдых 90 минут', rest('Отдых 90 минут', 90, '90 минут'))
    const beforeRepeat = await prisma.outboxMessage.findMany({ where: { userId: user.id } })
    await bot.text(A, 'Отдых 90 минут')
    expect(await prisma.outboxMessage.findMany({ where: { userId: user.id } })).toEqual(beforeRepeat)
    model.assertConsumed()
    const restart = makeBot({ now: new Date(pauseAt.getTime() + 10 * MIN), llm: model.provider })
    restart.ctx.remindersEnabled = true
    await reconcile(restart.ctx)
    await runOutboxOnce(restart.ctx)
    expect(restart.tg.sent).toHaveLength(0)
    restart.setNow(new Date(deadline.getTime() - MIN))
    await runOutboxOnce(restart.ctx)
    expect(restart.tg.sent).toHaveLength(0)
    restart.setNow(deadline)
    await runOutboxOnce(restart.ctx)
    expect(restart.tg.sent).toHaveLength(1)
    expect(restart.lastText(A)).not.toContain('Продолжишь')
    await runOutboxOnce(restart.ctx)
    expect(restart.tg.sent).toHaveLength(1)
    model.enqueue('Вернуться к работе', { route: 'continue_same', text: 'Вернуться к работе', minutes: null, durationSource: null, followUp: null })
    await restart.text(A, 'Вернуться к работе')
    expect(await prisma.focusSession.findUniqueOrThrow({ where: { id: session.id } })).toMatchObject({ state: 'running', taskId: task.id })
    model.assertConsumed()
  })
  it.each([0, 1] as const)('relative extra rest starts at the reply, policy %s', async policy => {
    const text = 'Ещё 40 минут отдыха'
    const bot = makeBot({ now: new Date('2026-10-07T11:00:00Z') })
    bot.ctx.remindersEnabled = true
    const user = await prisma.user.create({ data: { tgId: BigInt(A), reminderPolicy: policy, proactive: false, pingsEnabled: false } })
    const pausedAt = new Date('2026-10-07T10:54:31Z')
    const session = await prisma.focusSession.create({ data: {userId:user.id, state:'paused', reminderPolicy:policy, startedAt:new Date('2026-10-07T10:00:00Z'), pausedAt, plannedMinutes:40, plannedRestMinutes:10} })
    if (policy === 1) await prisma.$transaction(tx => replaceChain(tx, user, 'break', session, pausedAt, 10))
    await bot.textAs(A, text, {...rest(text,40,'40 минут'),durationBasis:'from_now'})
    const due = new Date('2026-10-07T11:40:00Z')
    if (policy === 1) expect(await prisma.reminderChain.findFirstOrThrow({where:{userId:user.id,status:'active'}})).toMatchObject({kind:'break',firstDueAt:due})
    else expect(await prisma.outboxMessage.findFirstOrThrow({where:{userId:user.id,kind:'break_over',status:'pending'}})).toMatchObject({sendAfter:due})
    expect(await prisma.focusSession.findUniqueOrThrow({where:{id:session.id}})).toMatchObject({state:'paused',pausedAt,taskId:null})
  })
  it.each([0, 1] as const)('explicit session end with five-minute rest keeps its actual deadline, policy %s', async policy => {
    const bot = makeBot({ now: new Date('2026-10-07T11:00:00Z') })
    bot.ctx.remindersEnabled = true
    const user = await prisma.user.create({data:{tgId:BigInt(A),reminderPolicy:policy,proactive:false,pingsEnabled:false}})
    const startedAt = new Date('2026-10-07T10:35:00Z')
    const session = await prisma.focusSession.create({data:{userId:user.id,state:'running',reminderPolicy:policy,startedAt,plannedMinutes:40,plannedRestMinutes:10}})
    if(policy===1) await prisma.workPeriod.create({data:{sessionId:session.id,startedAt}})
    const text = 'Сделал, отдыхаю 5 минут'
    await bot.textAs(A,text,{route:'end_session',text,outcome:'done',outcomeSource:'Сделал',completedTask:null,completionSource:null,rest:true,minutes:5,durationSource:'5 минут',followUp:null})
    const due = new Date('2026-10-07T11:05:00Z')
    expect(await prisma.focusSession.findUniqueOrThrow({where:{id:session.id}})).toMatchObject({state:'finished',outcome:'done',counted:true,restChoice:'rest',plannedRestMinutes:5})
    if(policy===1) expect(await prisma.reminderChain.findFirstOrThrow({where:{userId:user.id,status:'active',kind:'post_rest'}})).toMatchObject({firstDueAt:due})
    else expect(await prisma.outboxMessage.findFirstOrThrow({where:{userId:user.id,kind:'rest_over',status:'pending'}})).toMatchObject({sendAfter:due})
    bot.advance(4); await runOutboxOnce(bot.ctx)
    expect(bot.textsTo(A).filter(t=>t.includes('Отдых закончен'))).toHaveLength(0)
    bot.advance(1); await runOutboxOnce(bot.ctx)
    expect(await prisma.focusSession.findUniqueOrThrow({where:{id:session.id}})).toMatchObject({state:'finished',outcome:'done'})
  })

})
