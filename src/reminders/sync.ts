import type { FocusSession, Prisma } from '@prisma/client'
import { answerPlan, cancelPrimary, ensureMorning, replaceChain, resetChain } from './store.js'
import { backfillLegacyPeriods, closePeriod, openPeriod, projectAllocations } from './accounting.js'
import { MIN } from './cadence.js'
// Called within the same owner-locked mutation transaction as every manual flow.
export async function syncReminderState(tx: Prisma.TransactionClient,userId: string,before: FocusSession|null,now: Date,enabled: boolean): Promise<void> {
  const user=await tx.user.findUnique({where:{id:userId}})
  if(!user)return
  let active=await tx.focusSession.findFirst({where:{userId,state:{in:['running','paused','collecting_intent']}}})
  const newStart=active?.state==='running'&&active.plannedMinutes!==null&&(before?.id!==active.id||before.state==='collecting_intent')
  const legacyResume=active?.state==='running'&&active.plannedMinutes!==null&&before?.id===active.id&&before.state==='paused'
  if(enabled&&user.reminderPolicy===1&&legacyResume&&before?.reminderPolicy===0) await backfillLegacyPeriods(tx,userId,before)
  if(enabled&&user.reminderPolicy===1&&(newStart||legacyResume)&&active){
    active=await tx.focusSession.update({where:{id:active.id},data:{reminderPolicy:1,pingAt:null}})
    await answerPlan(tx,user,now,'work','manual_start')
  }
  if(before?.reminderPolicy===1&&['running','paused'].includes(before.state)&&(!active||active.id!==before.id||!['running','paused'].includes(active.state))){
    await closePeriod(tx,before.id,now);await projectAllocations(tx,userId,before.id,now)
    await cancelPrimary(tx,userId)
  }
  if(active?.reminderPolicy===1&&active.plannedMinutes!==null&&['running','paused'].includes(active.state)){
    const phase=active.state==='running'?'work':'break', interval=phase==='work'?active.plannedMinutes:active.plannedRestMinutes??10
    if(phase==='work')await openPeriod(tx,active.id,before?.state==='paused'?now:active.startedAt??now)
    else {await closePeriod(tx,active.id,active.pausedAt??now);await projectAllocations(tx,userId,active.id,now)}
    const c=await tx.reminderChain.findFirst({where:{userId,status:'active'}})
    if(!c||c.kind!==phase||c.sessionId!==active.id){
      await replaceChain(tx,user,phase,active,now,interval,{manual:true})
      // Resumed work starts at the action, not the old session boundary.
      if(phase==='work'&&before?.state==='paused'){
        await tx.workPeriod.updateMany({where:{sessionId:active.id,endedAt:null},data:{startedAt:now}})
      }
    }else if(before?.id===active.id&&(before.plannedMinutes!==active.plannedMinutes||before.plannedEndAt?.getTime()!==active.plannedEndAt?.getTime())&&phase==='work'){
      await resetChain(tx,c,now,interval)
      await tx.focusSession.update({where:{id:active.id},data:{plannedEndAt:new Date(now.getTime()+interval*MIN)}})
    }
    await tx.outboxMessage.updateMany({where:{userId,status:{in:['pending','paused','sending']},kind:{in:['ping','session_end','break_over','rest_over','meeting']}},data:{status:'canceled'}})
    await tx.focusSession.update({where:{id:active.id},data:{pingAt:null}})
  }
  // Explicit post-session rest is the sole trigger, never merely asking about it.
  if(before&&!active){
    const finished=await tx.focusSession.findUnique({where:{id:before.id}})
    if(finished?.reminderPolicy===1&&finished.restChoice==='rest'&&before.restChoice!=='rest'){
      await replaceChain(tx,user,'post_rest',finished,now,finished.plannedRestMinutes??10,{manual:true})
      await tx.outboxMessage.updateMany({where:{userId,kind:'rest_over',status:{in:['pending','paused','sending']}},data:{status:'canceled'}})
    }
  }
  if(user.reminderPolicy===1&&enabled&&!active)await ensureMorning(tx,user,now)
}
