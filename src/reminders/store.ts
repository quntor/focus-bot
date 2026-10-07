import type { Prisma, ReminderChain, FocusSession, User } from '@prisma/client'
import type { Ctx } from '../bot/context.js'
import { logEvent } from '../analytics/log.js'
import { dayKey } from '../lib/day.js'
import { nextLocalTime, parseClock } from '../lib/time.js'
import { allowedAt, MIN, nightAllowance, repeatMinutes, type Phase } from './cadence.js'
export async function lockUser(tx: Prisma.TransactionClient, id: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM users WHERE id = ${id} FOR UPDATE`
}
export async function cancelChain(tx: Prisma.TransactionClient, id: string): Promise<void> {
  await tx.reminderChain.updateMany({ where: { id, status: 'active' }, data: { status: 'canceled', revision: { increment: 1 } } })
  await tx.outboxMessage.updateMany({ where: { chainId: id, status: { in: ['pending','paused','sending'] } }, data: { status: 'canceled' } })
}
export async function cancelPrimary(tx: Prisma.TransactionClient, userId: string): Promise<void> {
  const chains = await tx.reminderChain.findMany({ where: { userId, status: 'active' } })
  for (const c of chains) await cancelChain(tx, c.id)
}
export async function slot(tx: Prisma.TransactionClient, chain: ReminderChain): Promise<void> {
  await tx.outboxMessage.createMany({data:[{userId:chain.userId,kind:'reminder',chainId:chain.id,chainRevision:chain.revision,ordinal:chain.ordinal,
    idempotencyKey:`reminder:${chain.id}:${chain.revision}:${chain.ordinal}`,sendAfter:chain.nextDueAt,payload:{chainId:chain.id}}],skipDuplicates:true})
}
export async function replaceChain(tx: Prisma.TransactionClient, user: User, kind: Phase, session: FocusSession|null, now: Date, interval: number, opts: { due?:Date; manual?:boolean; localDate?:string } = {}): Promise<ReminderChain> {
  await lockUser(tx,user.id)
  await cancelPrimary(tx,user.id)
  const first = opts.due ?? new Date(now.getTime()+interval*MIN)
  const chain = await tx.reminderChain.create({data:{userId:user.id,kind,sessionId:session?.id??undefined,localDate:opts.localDate??null,
    phaseStartedAt:now,firstDueAt:first,nextDueAt:first,intervalMinutes:interval,nightUntil:opts.manual?nightAllowance(user,now):null}})
  await slot(tx,chain)
  await logEvent(tx,user.id,'reminder_chain_changed',{chain_id:chain.id,kind,revision:chain.revision,reason:'start',interval_minutes:interval,next_due_ms:first.getTime()},{at:now,sessionId:session?.id??undefined})
  return chain
}
export async function resetChain(tx: Prisma.TransactionClient, chain: ReminderChain, now: Date, interval=chain.intervalMinutes, due=new Date(now.getTime()+interval*MIN)): Promise<ReminderChain> {
  await tx.outboxMessage.updateMany({where:{chainId:chain.id,status:{in:['pending','paused','sending']}},data:{status:'canceled'}})
  const next = await tx.reminderChain.update({where:{id:chain.id},data:{revision:{increment:1},ordinal:0,restStep:0,intervalMinutes:interval,
    firstDueAt:due,nextDueAt:due}})
  await slot(tx,next);await logEvent(tx,chain.userId,'reminder_chain_changed',{chain_id:next.id,kind:next.kind as Phase,revision:next.revision,reason:'cadence',interval_minutes:interval,next_due_ms:next.nextDueAt.getTime()},{at:now,sessionId:next.sessionId??undefined});return next
}
export async function advance(tx: Prisma.TransactionClient, chain: ReminderChain, anchor: Date): Promise<void> {
  const next = await tx.reminderChain.updateMany({where:{id:chain.id,revision:chain.revision,status:'active',ordinal:chain.ordinal},data:{
    ordinal:{increment:1},restStep:chain.kind==='break'||chain.kind==='post_rest'?{increment:1}:chain.restStep,
    deliveryAnchorAt:anchor,nextDueAt:new Date(anchor.getTime()+repeatMinutes(chain.kind,chain.intervalMinutes,chain.restStep)*MIN)}})
  if(next.count) await slot(tx,await tx.reminderChain.findUniqueOrThrow({where:{id:chain.id}}))
}
export async function answerPlan(tx: Prisma.TransactionClient,user: User,now: Date,answer: 'work'|'off',source: string): Promise<void> {
  const localDate=dayKey(now,user.timezone)
  await tx.calendarPlan.upsert({where:{userId_localDate:{userId:user.id,localDate}},create:{userId:user.id,localDate,answer,answeredAt:now,source},update:{answer,answeredAt:now,source}})
}
export async function ensureMorning(tx: Prisma.TransactionClient,user: User,now: Date): Promise<void> {
  await lockUser(tx,user.id)
  if(user.reminderPolicy!==1||!user.proactive||user.blockedAt||['timezone','start_time','ritual'].includes(user.pendingInput)) return
  if(await tx.reminderChain.count({where:{userId:user.id,status:'active'}})) return
  if(await tx.focusSession.count({where:{userId:user.id,state:{in:['running','paused','collecting_intent']}}})) return
  const date=dayKey(now,user.timezone), plan=await tx.calendarPlan.findUnique({where:{userId_localDate:{userId:user.id,localDate:date}}})
  const permitted=allowedAt(user,{nightUntil:null},now)
  if(!permitted) return
  const due=plan?nextLocalTime(user.timezone,parseClock(user.morningTime)!,now):permitted
  const off=await tx.dayOff.findUnique({where:{userId_dayKey:{userId:user.id,dayKey:dayKey(due,user.timezone)}}})
  const at=off?nextLocalTime(user.timezone,parseClock(user.morningTime)!,due):due
  await replaceChain(tx,user,'morning',null,now,60,{due:at,localDate:dayKey(at,user.timezone)})
}
export async function reconcile(ctx: Ctx): Promise<void> {
  let cursor: string|undefined
  for(;;){
  const users=await ctx.db.user.findMany({where:{reminderPolicy:1,blockedAt:null},orderBy:{id:'asc'},take:200,...(cursor?{cursor:{id:cursor},skip:1}:{})})
  if(!users.length)break
  cursor=users.at(-1)!.id
  for(const initial of users) await ctx.db.$transaction(async tx=>{
    await lockUser(tx,initial.id)
    const user=await tx.user.findUniqueOrThrow({where:{id:initial.id}}), now=ctx.now()
    let c=await tx.reminderChain.findFirst({where:{userId:user.id,status:'active'}})
    if(c){
      const s=c.sessionId?await tx.focusSession.findUnique({where:{id:c.sessionId}}):null
      if(c.kind==='morning'&&(c.localDate!==dayKey(now,user.timezone)&&c.nextDueAt<=now||await tx.focusSession.count({where:{userId:user.id,state:{in:['running','paused','collecting_intent']}}}))) {await cancelChain(tx,c.id);c=null}
      else if((c.kind==='work'&&s?.state!=='running')||(c.kind==='break'&&s?.state!=='paused')||(c.kind==='post_rest'&&await tx.focusSession.count({where:{userId:user.id,state:{in:['running','paused']}}}))){await cancelChain(tx,c.id);c=null}
    }
    if(!c){await ensureMorning(tx,user,now);return}
    const pending=await tx.outboxMessage.count({where:{chainId:c.id,chainRevision:c.revision,status:{in:['pending','sending','paused']}}})
    if(!pending){
      const frozen=await tx.outboxMessage.findFirst({where:{chainId:c.id,chainRevision:c.revision,ordinal:c.ordinal,lastError:'policy_disabled',status:'canceled'}})
      if(frozen)c=await tx.reminderChain.update({where:{id:c.id},data:{revision:{increment:1}}})
      await slot(tx,c)
    }
  })
  }
}

export async function freezeReminders(ctx: Ctx): Promise<void> {
  const owners=await ctx.db.reminderChain.findMany({where:{status:'active'},select:{userId:true}})
  for(const {userId} of owners)await ctx.db.$transaction(async tx=>{
    await lockUser(tx,userId)
    await tx.outboxMessage.updateMany({where:{userId,kind:'reminder',status:{in:['pending','paused']}},data:{status:'canceled',lastError:'policy_disabled'}})
  })
}
