import type { FocusSession, Prisma } from '@prisma/client'
import type { Db } from '../lib/db.js'

export interface TimelinePeriod { startedAt: Date; endedAt: Date | null }
export interface TimelineEvent { id: bigint; type: string; payload: Prisma.JsonValue | null; createdAt: Date }
export interface TimelineSummary {
  totalSeconds: number
  unassignedSeconds: number
  allocations: { taskId: string; seconds: number }[]
}

function payload(event: TimelineEvent): Record<string, unknown> {
  const value = event.payload
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

/** Attribution is separate from physical work: pauses/corrections only trim
 * intersections. Unknown intervals remain unknown; reminders add no boundaries. */
export function computeTimeline(periods: TimelinePeriod[], events: TimelineEvent[], now: Date): TimelineSummary {
  const spans: { start: number; end: number; taskId: string | null }[] = []
  const nodes = [
    ...periods.map((period) => ({ at: period.startedAt.getTime(), event: null as TimelineEvent | null })),
    ...events.filter((event) => event.createdAt <= now).map((event) => ({ at: event.createdAt.getTime(), event })),
  ].sort((a, b) => a.at - b.at || (a.event === null ? -1 : b.event === null ? 1 : a.event.id < b.event.id ? -1 : a.event.id > b.event.id ? 1 : 0))
  let cursor = nodes[0]?.at ?? now.getTime()
  let unassignedStart = cursor
  let taskId: string | null = null
  for (const node of nodes) {
    if (node.at > now.getTime()) break
    if (node.at > cursor) spans.push({ start: cursor, end: node.at, taskId })
    cursor = node.at
    if (!node.event) {
      unassignedStart = node.at
      continue
    }
    const data = payload(node.event)
    if (['session_started', 'intent_parsed', 'task_selected', 'task_switched'].includes(node.event.type)) {
      const selected = data[node.event.type === 'task_switched' ? 'to_task_id' : 'task_id']
      const nextTask = typeof selected === 'string' ? selected : null
      if (!taskId && nextTask && data.from_period_start === true) {
        for (const span of spans) {
          if (span.taskId === null && span.start >= unassignedStart) span.taskId = nextTask
        }
      }
      taskId = nextTask
      unassignedStart = node.at
    } else if (node.event.type === 'task_completed' && data.task_id === taskId) {
      taskId = null
      unassignedStart = node.at
    }
  }
  if (cursor < now.getTime()) spans.push({ start: cursor, end: now.getTime(), taskId })
  const milliseconds = new Map<string, number>()
  let total = 0
  for (const period of periods) {
    const start = period.startedAt.getTime()
    const end = Math.min((period.endedAt ?? now).getTime(), now.getTime())
    if (end <= start) continue
    total += end - start
    for (const span of spans) {
      const duration = Math.max(0, Math.min(end, span.end) - Math.max(start, span.start))
      if (span.taskId && duration > 0) milliseconds.set(span.taskId, (milliseconds.get(span.taskId) ?? 0) + duration)
    }
  }
  const allocations = [...milliseconds].map(([id, duration]) => ({ taskId: id, seconds: Math.floor(duration / 1000) }))
    .filter((allocation) => allocation.seconds > 0)
  const totalSeconds = Math.floor(total / 1000)
  return { totalSeconds, allocations, unassignedSeconds: totalSeconds - allocations.reduce((sum, allocation) => sum + allocation.seconds, 0) }
}

/** One-time explicit migration of a paused legacy session. Known event
 * boundaries become physical periods; an incomplete history remains an
 * unassigned aggregate rather than fabricated intervals/task proportions. */
export async function backfillLegacyPeriods(tx: Db, userId: string, before: FocusSession): Promise<void> {
  if (before.userId !== userId || before.reminderPolicy !== 0 || before.state !== 'paused' || !before.startedAt || !before.pausedAt) return
  if (await tx.workPeriod.count({ where: { sessionId: before.id } })) return
  const owner = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: { subjectId: true } })
  const events = await tx.event.findMany({ where: {
    subjectId: owner.subjectId, sessionId: before.id,
    type: { in: ['session_paused', 'session_resumed'] },
    // The current pause boundary is authoritative. Exclude the newly written
    // resume at that boundary as well as all future events.
    createdAt: { gte: before.startedAt, lt: before.pausedAt },
  }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
  const start = before.startedAt.getTime()
  const end = before.pausedAt.getTime()
  const historicalSeconds = Math.max(0, Math.floor((end - start) / 1000) - before.pausedSeconds)
  const periods: { sessionId: string; startedAt: Date; endedAt: Date }[] = []
  let cursor = start
  let pausedAt: number | null = null
  let completedPauses = 0
  let consistent = end >= start
  for (const event of events) {
    const at = event.createdAt.getTime()
    if (event.type === 'session_paused') {
      if (pausedAt !== null || at < cursor) { consistent = false; break }
      if (at > cursor) periods.push({ sessionId: before.id, startedAt: new Date(cursor), endedAt: event.createdAt })
      pausedAt = at
    } else {
      if (pausedAt === null || at < pausedAt) { consistent = false; break }
      cursor = at
      pausedAt = null
      completedPauses++
    }
  }
  if (pausedAt !== null) consistent = false // a resume boundary is missing
  if (consistent && end > cursor) periods.push({ sessionId: before.id, startedAt: new Date(cursor), endedAt: before.pausedAt })
  const physicalSeconds = Math.floor(periods.reduce((sum, period) => sum + period.endedAt.getTime() - period.startedAt.getTime(), 0) / 1000)
  // Legacy pausedSeconds floors each completed pause separately. Preserve its
  // sub-second rounding residual as unassigned, never invent a physical span.
  const residual = historicalSeconds - physicalSeconds
  if (residual < 0 || residual > completedPauses) consistent = false
  if (consistent && periods.length > 0) await tx.workPeriod.createMany({ data: periods })
  await tx.focusSession.update({ where: { id: before.id }, data: { legacyUnassignedSeconds: consistent ? residual : historicalSeconds } })
}

/** Caller owns the transaction/user lock; continue does not call openPeriod. */
export async function openPeriod(tx: Db, sessionId: string, now: Date): Promise<void> {
  const session = await tx.focusSession.findUnique({ where: { id: sessionId } })
  if (!session || session.reminderPolicy !== 1 || session.state !== 'running') return
  if (await tx.workPeriod.findFirst({ where: { sessionId, endedAt: null } })) return
  const last = await tx.workPeriod.findFirst({ where: { sessionId }, orderBy: { startedAt: 'desc' } })
  if (last?.endedAt && last.endedAt > now) return
  await tx.workPeriod.create({ data: { sessionId, startedAt: now } })
}

export async function closePeriod(tx: Db, sessionId: string, now: Date): Promise<void> {
  const session = await tx.focusSession.findUnique({ where: { id: sessionId }, select: { reminderPolicy: true } })
  if (session?.reminderPolicy !== 1) return
  await tx.workPeriod.updateMany({ where: { sessionId, endedAt: null, startedAt: { lte: now } }, data: { endedAt: now } })
}

export async function projectAllocations(tx: Db, userId: string, sessionId: string, now = new Date()): Promise<TimelineSummary> {
  const session = await tx.focusSession.findFirst({ where: { id: sessionId, userId, reminderPolicy: 1 }, include: { user: { select: { subjectId: true } } } })
  if (!session) return { totalSeconds: 0, unassignedSeconds: 0, allocations: [] }
  const periods = await tx.workPeriod.findMany({ where: { sessionId }, orderBy: { startedAt: 'asc' } })
  const events = await tx.event.findMany({ where: {
    sessionId, subjectId: session.user.subjectId,
    type: { in: ['session_started', 'intent_parsed', 'task_selected', 'task_switched', 'task_completed'] },
  }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
  const summary = computeTimeline(periods, events, now)
  summary.totalSeconds += session.legacyUnassignedSeconds
  const tasks = await tx.task.findMany({ where: { userId, id: { in: summary.allocations.map((allocation) => allocation.taskId) } }, select: { id: true } })
  const valid = new Set(tasks.map((task) => task.id))
  summary.allocations = summary.allocations.filter((allocation) => valid.has(allocation.taskId))
  summary.unassignedSeconds = summary.totalSeconds - summary.allocations.reduce((sum, allocation) => sum + allocation.seconds, 0)
  const hasReport = await tx.taskTimeAllocation.findFirst({ where: { sessionId, userId, source: 'report' } })
  await tx.taskTimeAllocation.deleteMany({ where: { sessionId, userId, source: 'timeline' } })
  if (!hasReport && summary.allocations.length > 0) await tx.taskTimeAllocation.createMany({ data: summary.allocations.map((allocation) => ({ ...allocation, sessionId, userId, source: 'timeline' })) })
  return summary
}

/** minutesAgo is relative to the original pause click, NOT correction time.
 * A receipt can only shorten the latest continuous period once. Cadence is
 * changed by the caller in the same transaction; pausedSeconds stays intact. */
export async function correctPause(tx: Db, userId: string, sessionId: string, correctionId: string, minutesAgo: number, now: Date): Promise<{ corrected: boolean; pausedAt: Date }> {
  const session = await tx.focusSession.findFirst({ where: { id: sessionId, userId } })
  if (!session || session.reminderPolicy !== 1 || session.state !== 'paused' || !session.pausedAt || !correctionId || !Number.isFinite(minutesAgo) || minutesAgo <= 0) {
    throw new RangeError('Pause correction is not valid for this session')
  }
  const period = await tx.workPeriod.findFirst({ where: { sessionId }, orderBy: { startedAt: 'desc' } })
  if (!period?.endedAt || period.endedAt.getTime() !== session.pausedAt.getTime()) throw new RangeError('No current closed work period')
  if (period.correctionId !== null) {
    if (period.correctionId === correctionId && period.originalEndedAt && period.endedAt.getTime() === period.originalEndedAt.getTime() - minutesAgo * 60_000) {
      return { corrected: false, pausedAt: session.pausedAt }
    }
    throw new RangeError('This pause has already been corrected')
  }
  const pausedAt = new Date(period.endedAt.getTime() - minutesAgo * 60_000)
  if (!Number.isFinite(pausedAt.getTime()) || pausedAt < period.startedAt || pausedAt > now || period.endedAt > now) throw new RangeError('Correction crosses the current work period')
  const changed = await tx.workPeriod.updateMany({ where: { id: period.id, correctionId: null, endedAt: period.endedAt }, data: { endedAt: pausedAt, originalEndedAt: period.endedAt, correctionId } })
  if (changed.count !== 1) throw new RangeError('Concurrent pause correction')
  await tx.focusSession.update({ where: { id: sessionId }, data: { pausedAt } })
  await projectAllocations(tx, userId, sessionId, now)
  return { corrected: true, pausedAt }
}
