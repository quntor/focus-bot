import { beforeEach, describe, expect, it } from 'vitest'
import { makeBot } from '../test/bot.js'
import { hasDb, prisma, resetDb } from '../test/db.js'
import { sendSettings } from './account.js'
import { ensureNextMeeting } from './day-flow.js'
import { sweepOnce } from '../jobs/sweeper.js'
import { runOutboxOnce } from '../outbox/worker.js'

const A = 5757

describe.skipIf(!hasDb)('Выходные и рабочие часы', () => {
  beforeEach(resetDb)
  async function setup(policy = 0) {
    const bot = makeBot({ now: new Date('2026-10-09T08:00:00Z') })
    const user = await prisma.user.create({ data: { tgId: BigInt(A), reminderPolicy: policy } })
    bot.ctx.remindersEnabled = true
    await sendSettings(bot.ctx, user)
    return { bot, user }
  }
  it('opens from settings, persists weekdays and makes old buttons idempotent', async () => {
    const {bot,user} = await setup()
    await bot.press(A,bot.lastButton(A,'set:',':schedule'))
    expect(bot.lastText(A)).toContain('Europe/Moscow')
    expect(bot.lastText(A)).toContain('таймера')
    const off = bot.lastButton(A,'set:',':day_5_off')
    await bot.press(A,off)
    await bot.press(A,off)
    expect((await prisma.user.findUniqueOrThrow({where:{id:user.id}})).notificationDays).toBe(95)
    await bot.press(A,'set::schedule')
    expect(bot.tg.sent.at(-1)?.keyboard?.flat().find(b=>b.text==='⬜ Сб')).toBeTruthy()
  })
  it('clock input uses semantic pending and invalid range preserves saved hours', async () => {
    const {bot,user}=await setup()
    await bot.press(A,'set::schedule_end')
    const clock=(text:string,hour:number)=>({route:'answer_pending',text,answer:{kind:'clock',hour,minute:0,day:'next'},followUp:null})
    await bot.textAs(A,'09:00',clock('09:00',9))
    expect(bot.lastText(A)).toContain('раньше конца')
    expect(await prisma.user.findUniqueOrThrow({where:{id:user.id}})).toMatchObject({eveningTime:'21:00',pendingInput:'schedule_end'})
    await bot.textAs(A,'18:00',clock('18:00',18))
    expect(await prisma.user.findUniqueOrThrow({where:{id:user.id}})).toMatchObject({eveningTime:'18:00',pendingInput:'none'})
    await bot.press(A,'set::schedule_start')
    await bot.textAs(A,'08:00',clock('08:00',8))
    expect(bot.lastText(A)).toContain('08:00–18:00')
  })
  it.each([0,1])('no days creates no morning; reenable schedules an allowed day policy=%s', async policy=>{
    const {bot,user}=await setup(policy)
    await prisma.user.update({where:{id:user.id},data:{notificationDays:0}})
    await prisma.$transaction(tx=>ensureNextMeeting(tx,{...user,notificationDays:0},bot.now()))
    expect(await prisma.outboxMessage.count({where:{userId:user.id,status:'pending'}})).toBe(0)
    await bot.press(A,'set::day_0_on')
    const queued=await prisma.outboxMessage.findFirstOrThrow({where:{userId:user.id,status:'pending'}})
    expect(queued.sendAfter.toISOString()).toBe('2026-10-12T07:00:00.000Z')
  })
  it('changing days during a running timer preserves session and physical history',async()=>{
    const {bot,user}=await setup(1)
    await bot.textAs(A,'/focus',{route:'control',text:'/focus',action:'focus',value:null,followUp:null})
    const before=await prisma.focusSession.findFirstOrThrow({where:{userId:user.id}})
    const periods=await prisma.workPeriod.findMany({where:{sessionId:before.id}})
    await bot.press(A,'set::day_4_off')
    expect(await prisma.focusSession.findUniqueOrThrow({where:{id:before.id}})).toEqual(before)
    expect(await prisma.workPeriod.findMany({where:{sessionId:before.id}})).toEqual(periods)
    bot.setNow(before.plannedEndAt!)
    const sent=bot.tg.sent.length
    await runOutboxOnce(bot.ctx)
    expect(bot.tg.sent.length).toBeGreaterThan(sent)
  })
  it('legacy automatic cleanup still accounts work but does not send on an excluded day',async()=>{
    const {bot,user}=await setup()
    await bot.textAs(A,'/focus',{route:'control',text:'/focus',action:'focus',value:null,followUp:null})
    await prisma.user.update({where:{id:user.id},data:{notificationDays:0}})
    bot.advance(180)
    const sent=bot.tg.sent.length
    await sweepOnce(bot.ctx)
    expect(bot.tg.sent.length).toBe(sent)
    expect((await prisma.focusSession.findFirstOrThrow({where:{userId:user.id}})).state).toBe('finished')
  })
})
