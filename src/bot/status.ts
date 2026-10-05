import type { User } from '@prisma/client'
import { reply, type Ctx } from './context.js'
import { T } from './texts.js'

function elapsed(start: Date, now: Date): string {
  const seconds = Math.floor(Math.max(0, now.getTime() - start.getTime()) / 1000)
  const minutes = Math.floor(seconds / 60)
  return minutes < 1 ? `${seconds} сек` : `${minutes} мин`
}

// Только факты из БД: статус не запускает таймер и не потребляет pendingInput.
export async function showStatus(ctx: Ctx, user: User): Promise<void> {
  const now = ctx.now()
  const text = await ctx.db.$transaction(async (tx) => {
    const active = await tx.focusSession.findFirst({
      where: { userId: user.id, state: { in: ['running', 'paused', 'collecting_intent'] } },
      orderBy: { createdAt: 'desc' }, include: { task: true },
    })
    const session = active ?? await tx.focusSession.findFirst({
      where: { userId: user.id }, orderBy: { createdAt: 'desc' }, include: { task: true },
    })
    if (!session) return T.statusIdle
    if (session.state === 'collecting_intent') return T.statusPreparing
    const resting = session.state === 'paused' || (session.state === 'finished' && session.restChoice === 'rest' && !session.restEndedAt)
    if (session.state !== 'running' && !resting) return T.statusIdle

    let start: Date | null = resting ? session.pausedAt : session.startedAt
    if (session.state === 'running') {
      const period = await tx.workPeriod.findFirst({ where: { sessionId: session.id, endedAt: null }, orderBy: { startedAt: 'desc' } })
      const resumed = period ? null : await tx.event.findFirst({
        where: { subjectId: user.subjectId, sessionId: session.id, type: 'session_resumed' }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      })
      start = period?.startedAt ?? resumed?.createdAt ?? start
    } else if (!start) {
      // Закрытие сессии во время отдыха очищает pausedAt, но сохраняет журнал.
      const event = await tx.event.findFirst({
        where: { subjectId: user.subjectId, sessionId: session.id, type: 'rest_chosen', payload: { path: ['choice'], equals: 'rest' } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      })
      start = event?.createdAt ?? null
    }
    const title = session.task?.title ?? session.intentText
    const lines: string[] = [resting ? T.statusRest : T.statusWork]
    lines.push(start ? T.statusElapsed(elapsed(start, now)) : T.statusUnknownTime)
    if (title) lines.push(T.statusTask(title, resting))
    else lines.push(T.statusNoTask)
    if (!resting && session.plannedEndAt && now >= session.plannedEndAt) lines.push(T.statusDeadlinePassed)
    return lines.join('\n')
  }, { isolationLevel: 'RepeatableRead' })
  await reply(ctx, user, text, undefined, { informational: true })
}
