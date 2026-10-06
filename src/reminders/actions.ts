import type { User } from '@prisma/client'
import type { Ctx } from '../bot/context.js'
import { reply } from '../bot/context.js'
import { cb } from '../bot/callbacks.js'
import type { Keyboard } from '../tg/client.js'
import { dayKey, workDayKey } from '../lib/day.js'
import { buildSummary } from '../bot/day-flow.js'
import { T, hhmm } from '../bot/texts.js'
import { currentInputTransaction } from '../bot/input-lock.js'
import { StaleTransition } from '../session/fsm.js'
import { MIN, midnight, nightAllowance } from './cadence.js'
import { answerPlan, cancelPrimary, lockUser, replaceChain, resetChain } from './store.js'
import { closePeriod, openPeriod, projectAllocations, correctPause } from './accounting.js'
import { logEvent } from '../analytics/log.js'
import { askIntent } from '../bot/session-flow.js'
export function quietKeyboard(user: Pick<User,'quietUntil'>,now: Date): Keyboard {
  return user.quietUntil && user.quietUntil>now ? [[{text:'Возобновить напоминания',data:cb('cycle',null,'unmute')}]] : [
    [{text:'Сегодня больше не беспокоить',data:cb('cycle',null,'stop')}],
    [{text:'Отключить уведомления',data:cb('cycle',null,'quiet')}]]
}
export async function onReminderAction(ctx: Ctx,user: User,id: string|null,arg: string, options: { restMinutes?: number } = {}): Promise<void> {
  let start=false, text='Напоминания обновлены.', pauseId: string|null=null
  try {await currentInputTransaction(ctx,async tx=>{
    await lockUser(tx,user.id)
    const fresh=await tx.user.findUniqueOrThrow({where:{id:user.id}}),now=ctx.now()
    let chain=await tx.reminderChain.findFirst({where:{userId:user.id,status:'active'}})
    if(id){
      const m=await tx.outboxMessage.findFirst({where:{id,userId:user.id},include:{chain:true}})
      if(!m?.chain||m.chain.status!=='active'||m.chainRevision!==m.chain.revision||!['sent','uncertain','sending'].includes(m.status)) throw new StaleTransition()
      chain=m.chain
      if(chain.kind==='morning'&&chain.localDate!==dayKey(now,fresh.timezone)) throw new StaleTransition()
    } else if(!['quiet','stop','unmute','break','resume','continue','rest'].includes(arg)) throw new StaleTransition()
    if(chain){const action=arg==='quiet'?'mute':arg==='stop'?'stop_today':arg;await logEvent(tx,user.id,'reminder_answered',{chain_id:chain.id,kind:chain.kind as 'morning'|'work'|'break'|'post_rest',revision:chain.revision,action:action as 'work'|'off'|'continue'|'break'|'resume'|'rest'|'mute'|'unmute'|'stop_today'},{at:now})}
    const session=await tx.focusSession.findFirst({where:{userId:user.id,state:{in:['running','paused','collecting_intent']}}})
    if(arg==='quiet'||arg==='stop'){
      await tx.user.update({where:{id:user.id},data:{quietUntil:midnight(fresh,now)}})
      if(arg==='stop'){
        await tx.focusSession.updateMany({where:{userId:user.id,state:'finished',restChoice:'rest',restEndedAt:null},data:{restEndedAt:now}})
        if(session){
          const paused=session.state==='paused'&&session.pausedAt?Math.floor((now.getTime()-session.pausedAt.getTime())/1000):0
          await tx.focusSession.update({where:{id:session.id},data:{state:session.state==='collecting_intent'?'cancelled':'finished',finishedAt:now,outcome:null,counted:false,pausedAt:null,pausedSeconds:{increment:Math.max(0,paused)}}})
          await closePeriod(tx,session.id,now);await projectAllocations(tx,user.id,session.id,now)
        }
        await cancelPrimary(tx,user.id)
        await tx.user.update({where:{id:user.id},data:{pendingInput:'none'}})
        const day = workDayKey(now, fresh.timezone)
        const summary = await buildSummary(tx, fresh, day, now)
        await tx.dailyGoal.upsert({where:{userId_dayKey:{userId:user.id,dayKey:day}},create:{userId:user.id,dayKey:day,summarySentAt:now},update:{summarySentAt:now}})
        const summaries = await tx.outboxMessage.findMany({where:{userId:user.id,kind:'summary',status:{in:['pending','paused']}},select:{id:true,payload:true}})
        const currentIds = summaries.filter(m=>(m.payload as {dayKey?:string}|null)?.dayKey===day).map(m=>m.id)
        await tx.outboxMessage.updateMany({where:{id:{in:currentIds}},data:{status:'canceled'}})
        await logEvent(tx,user.id,'day_closed',{day_key:day,via:'button'},{at:now})
        text=`${T.summary(summary)}\n\nНа сегодня остановились. Время сохранено без отметки о результате; напоминания выключены до полуночи.`
      }else text='Уведомления выключены до местной полуночи. Текущий режим не изменён.'
      await tx.outboxMessage.updateMany({where:{userId:user.id,status:{in:['pending','paused']},kind:{not:'reminder'}},data:{sendAfter:midnight(fresh,now)}})
      return
    }
    if(arg==='unmute'){
      await tx.user.update({where:{id:user.id},data:{quietUntil:null}})
      if(chain) await resetChain(tx,chain,now)
      text='Напоминания возобновлены. Следующий вопрос — через полный интервал текущего режима.';return
    }
    if(arg==='work'||arg==='off'){
      if(chain?.kind!=='morning') throw new StaleTransition()
      await answerPlan(tx,fresh,now,arg,'morning');await cancelPrimary(tx,user.id)
      text=arg==='off'?'Сегодня выходной. При желании работу можно начать вручную.':'Хорошо. Выбери, с чего начнёшь.'
      start=arg==='work';return
    }
    if(chain?.kind==='post_rest'){if(arg==='resume'){await cancelPrimary(tx,user.id);start=true;return}if(arg==='rest'){await resetChain(tx,chain,now);text='Ещё отдыхаем. Начало отдыха не меняется.';return}}
    if(!session||session.reminderPolicy!==1||session.plannedMinutes===null) throw new StaleTransition()
    if(arg==='break'){
      if(session.state!=='running'||chain?.kind!=='work') throw new StaleTransition()
      await tx.focusSession.update({where:{id:session.id},data:{state:'paused',pausedAt:now}})
      await closePeriod(tx,session.id,now);await projectAllocations(tx,user.id,session.id,now)
      const duration=options.restMinutes??session.plannedRestMinutes??10
      const rest=await replaceChain(tx,fresh,'break',session,now,duration,{manual:true})
      await logEvent(tx,user.id,'session_paused',{session_id:session.id,elapsed_minutes:Math.max(0,Math.floor(((now.getTime()-(session.startedAt??now).getTime())/1000-session.pausedSeconds)/60))},{at:now,sessionId:session.id})
      pauseId=(await tx.workPeriod.findFirstOrThrow({where:{sessionId:session.id},orderBy:{startedAt:'desc'}})).id;text=`Перерыв начат сейчас — ${duration} мин. Напишу в ${hhmm(rest.firstDueAt,fresh.timezone)}. Если уже отдыхал, можно уточнить начало.`
    }else if(arg==='resume'){
      if(session.state!=='paused'||!session.pausedAt||chain?.kind!=='break') throw new StaleTransition()
      const pause=Math.max(0,Math.floor((now.getTime()-session.pausedAt.getTime())/1000))
      await tx.focusSession.update({where:{id:session.id},data:{state:'running',pausedAt:null,pausedSeconds:{increment:pause},plannedEndAt:new Date(now.getTime()+session.plannedMinutes*MIN)}})
      await logEvent(tx,user.id,'session_resumed',{session_id:session.id,paused_minutes:Math.floor(pause/60)},{at:now,sessionId:session.id})
      await openPeriod(tx,session.id,now);await replaceChain(tx,fresh,'work',session,now,session.plannedMinutes,{manual:true});text='Вернулись к работе. Новый полный интервал в той же сессии.'
    }else if(arg==='continue'){
      if(session.state!=='running'||chain?.kind!=='work') throw new StaleTransition()
      await tx.focusSession.update({where:{id:session.id},data:{plannedEndAt:new Date(now.getTime()+session.plannedMinutes*MIN)}})
      const c=await resetChain(tx,chain,now,session.plannedMinutes)
      await tx.reminderChain.update({where:{id:c.id},data:{nightUntil:nightAllowance(fresh,now)}})
      text='Продолжаем. Следующий вопрос — через полный рабочий интервал.'
    }else if(arg==='rest'){
      if(!chain||!['break','post_rest'].includes(chain.kind)) throw new StaleTransition()
      await resetChain(tx,chain,now);text='Ещё отдыхаем. Начало перерыва не меняется.'
    }else throw new StaleTransition()
    await tx.user.updateMany({where:{id:user.id,pendingInput:{in:['none',`session_end:${session.id}`]}},data:{pendingInput:'none'}})
  })}catch(e){if(e instanceof StaleTransition)return reply(ctx,user,'Эта кнопка уже неактуальна.');throw e}
  if(start)return askIntent(ctx,user)
  const fresh=await ctx.db.user.findUniqueOrThrow({where:{id:user.id}})
  const keyboard=pauseId?[[{text:'Уже отдыхаю',data:cb('retro',pauseId,'choose')}],...quietKeyboard(fresh,ctx.now())]:quietKeyboard(fresh,ctx.now())
  await reply(ctx,user,text,arg==='stop'?undefined:keyboard)
}
export async function onRetro(ctx: Ctx,user: User,id: string,arg: string): Promise<void> {
  const selected=await ctx.db.workPeriod.findFirst({where:{id,session:{userId:user.id,state:'paused',reminderPolicy:1}},include:{session:true}})
  const s=selected?.session
  const latest=s?await ctx.db.workPeriod.findFirst({where:{sessionId:s.id},orderBy:{startedAt:'desc'}}):null
  if(!s||latest?.id!==id)return reply(ctx,user,'Эта кнопка уже неактуальна.')
  if(arg==='choose')return reply(ctx,user,'Когда начался перерыв?',[[5,10,15].map(n=>({text:`${n} минут назад`,data:cb('retro',id,`m${n}`)})),[{text:'Своё время',data:cb('retro',id,'custom')}]])
  if(arg==='custom'){
    await ctx.db.$transaction(async tx=>{await lockUser(tx,user.id);const current=await tx.focusSession.findFirst({where:{id:s.id,userId:user.id,state:'paused'}});if(current)await tx.user.update({where:{id:user.id},data:{pendingInput:`retro:${id}`}})})
    return reply(ctx,user,'Сколько минут до нажатия «Перерыв» ты уже отдыхал?')
  }
  const minutes=Number(arg.replace(/^m/,''))
  if(!Number.isFinite(minutes)||minutes<=0||minutes>1440)return reply(ctx,user,'Укажи положительное число минут.')
  try{await ctx.db.$transaction(async tx=>{
    await lockUser(tx,user.id)
    const period=await tx.workPeriod.findFirstOrThrow({where:{sessionId:s.id},orderBy:{startedAt:'desc'}})
    if(period.id!==id)throw new StaleTransition()
    const correction=await correctPause(tx,user.id,s.id,`pause:${period.id}`,minutes,ctx.now())
    if(!correction.corrected)return
    const c=await tx.reminderChain.findFirstOrThrow({where:{userId:user.id,sessionId:s.id,kind:'break',status:'active'}})
    await logEvent(tx,user.id,'reminder_answered',{chain_id:c.id,kind:'break',revision:c.revision,action:'retro'},{at:ctx.now()})
    const reset=await resetChain(tx,c,ctx.now())
    await tx.reminderChain.update({where:{id:reset.id},data:{nextDueAt:new Date(ctx.now().getTime()+10*MIN)}})
    await tx.outboxMessage.updateMany({where:{chainId:reset.id,chainRevision:reset.revision,status:'pending'},data:{sendAfter:new Date(ctx.now().getTime()+10*MIN)}})
    await tx.user.updateMany({where:{id:user.id,pendingInput:`retro:${id}`},data:{pendingInput:'none'}})
  })}catch(e){if(e instanceof StaleTransition||e instanceof RangeError)return reply(ctx,user,'Уточнение выходит за текущий рабочий период или уже применено.');throw e}
  // Manual confirmation buttons are allowed on the current slot before send.
  await reply(ctx,user,'Начало отдыха уточнено; время работы пересчитано. Вернёшься или ещё отдохнёшь?',[[{text:'Вернуться к работе',data:cb('cycle',null,'resume')},{text:'Ещё отдыхаю',data:cb('cycle',null,'rest')}],...quietKeyboard(user,ctx.now())])
}
