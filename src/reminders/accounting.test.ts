import { beforeEach, describe, expect, it } from 'vitest'
import { computeTimeline, backfillLegacyPeriods, closePeriod, openPeriod, projectAllocations, correctPause, type TimelineEvent } from './accounting.js'
import { hasDb, prisma, resetDb } from '../test/db.js'

const BASE = Date.parse('2026-10-05T07:00:00Z')
const at = (minutes: number) => new Date(BASE + minutes * 60_000)
const period = (start: number, end: number | null) => ({ startedAt: at(start), endedAt: end === null ? null : at(end) })
const event = (minute: number, type: string, payload: TimelineEvent['payload'], id = BigInt(minute + 1)): TimelineEvent => ({ id, createdAt: at(minute), type, payload })

describe('work period projection', () => {
  it('intersects task switches with all work periods, excluding every pause', () => {
    expect(computeTimeline([period(0, 30), period(40, 70)], [
      event(0, 'session_started', { task_id: 'a' }),
      event(20, 'task_switched', { from_task_id: 'a', to_task_id: 'b' }),
      event(50, 'task_completed', { task_id: 'b' }),
      event(60, 'task_selected', { task_id: 'c' }),
    ], at(100))).toEqual({ totalSeconds: 3600, unassignedSeconds: 600, allocations: [
      { taskId: 'a', seconds: 1200 }, { taskId: 'b', seconds: 1200 }, { taskId: 'c', seconds: 600 },
    ] })
  })

  it('retroactive attachment uses only the current period, not a prior unassigned one', () => {
    expect(computeTimeline([period(0, 20), period(30, 60)], [
      event(40, 'intent_parsed', { task_id: 'a', from_period_start: true }),
    ], at(60))).toEqual({ totalSeconds: 3000, unassignedSeconds: 1200, allocations: [{ taskId: 'a', seconds: 1800 }] })
  })

  it('from_period_start after completion attaches only the unassigned remainder', () => {
    expect(computeTimeline([period(0, 60)], [
      event(0, 'session_started', { task_id: 'a' }),
      event(20, 'task_completed', { task_id: 'a' }),
      event(30, 'task_selected', { task_id: 'b', from_period_start: true }),
    ], at(60))).toEqual({ totalSeconds: 3600, unassignedSeconds: 0, allocations: [
      { taskId: 'a', seconds: 1200 }, { taskId: 'b', seconds: 2400 },
    ] })
  })

  it('correction trims late switches without guessing a proportional split', () => {
    const events = [event(0, 'session_started', { task_id: 'a' }), event(30, 'task_switched', { from_task_id: 'a', to_task_id: 'b' }), event(50, 'task_switched', { from_task_id: 'b', to_task_id: 'c' })]
    expect(computeTimeline([period(0, 45)], events, at(65))).toEqual({ totalSeconds: 2700, unassignedSeconds: 0, allocations: [
      { taskId: 'a', seconds: 1800 }, { taskId: 'b', seconds: 900 },
    ] })
  })

  it('late from_period_start attachment survives a corrected physical end', () => {
    expect(computeTimeline([period(0, 45)], [event(50, 'task_selected', { task_id: 'a', from_period_start: true })], at(60)))
      .toEqual({ totalSeconds: 2700, unassignedSeconds: 0, allocations: [{ taskId: 'a', seconds: 2700 }] })
  })

  it('unselected work stays unassigned; running time uses now, not planned duration', () => {
    expect(computeTimeline([period(0, null)], [], at(120)))
      .toEqual({ totalSeconds: 7200, unassignedSeconds: 7200, allocations: [] })
  })

  it('equal-time events follow receipt order and ignore unrelated completion', () => {
    expect(computeTimeline([period(0, 20)], [
      event(0, 'session_started', { task_id: 'a' }, 1n),
      event(10, 'task_selected', { task_id: 'b' }, 3n),
      event(10, 'task_completed', { task_id: 'a' }, 2n),
      event(15, 'task_completed', { task_id: 'a' }, 4n),
    ], at(20))).toEqual({ totalSeconds: 1200, unassignedSeconds: 0, allocations: [{ taskId: 'a', seconds: 600 }, { taskId: 'b', seconds: 600 }] })
  })
})

describe.skipIf(!hasDb)('work periods and retro pause persistence', () => {
  beforeEach(resetDb)
  async function fixture() {
    const user = await prisma.user.create({ data: { tgId: 987654321n } })
    const a = await prisma.task.create({ data: { userId: user.id, title: 'A' } })
    const b = await prisma.task.create({ data: { userId: user.id, title: 'B' } })
    const session = await prisma.focusSession.create({ data: { userId: user.id, state: 'paused', reminderPolicy: 1, startedAt: at(0), pausedAt: at(60), pausedSeconds: 600 } })
    await prisma.workPeriod.create({ data: { sessionId: session.id, startedAt: at(0), endedAt: at(60) } })
    for (const e of [event(0, 'session_started', { task_id: a.id }), event(30, 'task_switched', { from_task_id: a.id, to_task_id: b.id })]) {
      await prisma.event.create({ data: { subjectId: user.subjectId, sessionId: session.id, type: e.type, payload: e.payload!, createdAt: e.createdAt, userRole: 'active', dayKey: '2026-10-05' } })
    }
    return { user, a, b, session }
  }

  it('corrects relative to original pause, persists receipt, and reprojects without changing pausedSeconds', async () => {
    const { user, a, b, session } = await fixture()
    const result = await prisma.$transaction((tx) => correctPause(tx, user.id, session.id, 'receipt', 15, at(65)))
    expect(result).toEqual({ corrected: true, pausedAt: at(45) })
    expect(await prisma.focusSession.findUniqueOrThrow({ where: { id: session.id } })).toMatchObject({ pausedAt: at(45), pausedSeconds: 600 })
    expect(await prisma.workPeriod.findFirstOrThrow({ where: { sessionId: session.id } })).toMatchObject({ endedAt: at(45), correctionId: 'receipt', originalEndedAt: at(60) })
    expect(await prisma.taskTimeAllocation.findMany({ where: { sessionId: session.id }, orderBy: { seconds: 'desc' }, select: { taskId: true, seconds: true, source: true } }))
      .toEqual([{ taskId: a.id, seconds: 1800, source: 'timeline' }, { taskId: b.id, seconds: 900, source: 'timeline' }])
    expect(await prisma.$transaction((tx) => correctPause(tx, user.id, session.id, 'receipt', 15, at(90))))
      .toEqual({ corrected: false, pausedAt: at(45) })
    await expect(prisma.$transaction((tx) => correctPause(tx, user.id, session.id, 'receipt', 10, at(90)))).rejects.toThrow(RangeError)
    await expect(prisma.$transaction((tx) => correctPause(tx, user.id, session.id, 'other', 15, at(90)))).rejects.toThrow(RangeError)
  })

  it('rejects owner/policy/state mismatch and crossing earlier period without writes', async () => {
    const { user, session } = await fixture()
    const other = await prisma.user.create({ data: { tgId: 987654322n } })
    for (const [owner, minutes] of [[other.id, 15], [user.id, 61], [user.id, -5], [user.id, NaN]] as const) {
      await expect(prisma.$transaction((tx) => correctPause(tx, owner, session.id, 'receipt', minutes, at(65)))).rejects.toThrow(RangeError)
    }
    await prisma.focusSession.update({ where: { id: session.id }, data: { reminderPolicy: 0 } })
    await expect(prisma.$transaction((tx) => correctPause(tx, user.id, session.id, 'receipt', 15, at(65)))).rejects.toThrow(RangeError)
    await prisma.focusSession.update({ where: { id: session.id }, data: { reminderPolicy: 1, state: 'running', pausedAt: null } })
    await expect(prisma.$transaction((tx) => correctPause(tx, user.id, session.id, 'receipt', 15, at(65)))).rejects.toThrow(RangeError)
    expect(await prisma.workPeriod.findFirstOrThrow({ where: { sessionId: session.id } })).toMatchObject({ endedAt: at(60), correctionId: null })
  })

  it('rejects crossing the latest segment even when session start would permit it', async () => {
    const { user, session } = await fixture()
    await prisma.workPeriod.updateMany({ where: { sessionId: session.id }, data: { endedAt: at(20) } })
    await prisma.workPeriod.create({ data: { sessionId: session.id, startedAt: at(40), endedAt: at(60) } })
    await expect(prisma.$transaction((tx) => correctPause(tx, user.id, session.id, 'receipt', 25, at(65)))).rejects.toThrow(RangeError)
    expect(await prisma.workPeriod.findMany({ where: { sessionId: session.id }, orderBy: { startedAt: 'asc' }, select: { startedAt: true, endedAt: true } })).toEqual([period(0, 20), period(40, 60)])
    expect((await prisma.focusSession.findUniqueOrThrow({ where: { id: session.id } })).pausedAt).toEqual(at(60))
  })

  it('rolls period, pause and allocation changes back together if caller aborts', async () => {
    const { user, session } = await fixture()
    await expect(prisma.$transaction(async (tx) => {
      await correctPause(tx, user.id, session.id, 'receipt', 15, at(65))
      throw new Error('abort')
    })).rejects.toThrow('abort')
    expect(await prisma.workPeriod.findFirstOrThrow({ where: { sessionId: session.id } })).toMatchObject({ endedAt: at(60), correctionId: null, originalEndedAt: null })
    expect((await prisma.focusSession.findUniqueOrThrow({ where: { id: session.id } })).pausedAt).toEqual(at(60))
    expect(await prisma.taskTimeAllocation.count({ where: { sessionId: session.id } })).toBe(0)
  })

  it('preserves explicit report allocations across correction and projection', async () => {
    const { user, a, session } = await fixture()
    await prisma.taskTimeAllocation.create({ data: { userId: user.id, sessionId: session.id, taskId: a.id, source: 'report', seconds: 1234 } })
    await prisma.$transaction((tx) => correctPause(tx, user.id, session.id, 'receipt', 15, at(65)))
    await prisma.$transaction((tx) => projectAllocations(tx, user.id, session.id, at(80)))
    expect(await prisma.taskTimeAllocation.findMany({ where: { sessionId: session.id }, select: { seconds: true, source: true } })).toEqual([{ seconds: 1234, source: 'report' }])
  })

  it('incomplete legacy history preserves old work as an unassigned aggregate exactly once', async () => {
    const { user, b, session } = await fixture()
    await prisma.workPeriod.deleteMany({ where: { sessionId: session.id } })
    const before = await prisma.focusSession.update({ where: { id: session.id }, data: { reminderPolicy: 0 } })
    await prisma.$transaction(async (tx) => {
      await backfillLegacyPeriods(tx, user.id, before)
      await tx.focusSession.update({ where: { id: session.id }, data: { reminderPolicy: 1, state: 'running', pausedAt: null } })
      await openPeriod(tx, session.id, at(70))
      await closePeriod(tx, session.id, at(85))
    })
    expect((await prisma.focusSession.findUniqueOrThrow({ where: { id: session.id } })).legacyUnassignedSeconds).toBe(3000)
    expect(await prisma.workPeriod.findMany({ where: { sessionId: session.id }, select: { startedAt: true, endedAt: true } })).toEqual([period(70, 85)])
    for (let i = 0; i < 2; i++) {
      expect(await prisma.$transaction((tx) => projectAllocations(tx, user.id, session.id, at(85))))
        .toEqual({ totalSeconds: 3900, unassignedSeconds: 3000, allocations: [{ taskId: b.id, seconds: 900 }] })
    }
    await prisma.$transaction((tx) => backfillLegacyPeriods(tx, user.id, before))
    expect(await prisma.workPeriod.count({ where: { sessionId: session.id } })).toBe(1)
    expect((await prisma.focusSession.findUniqueOrThrow({ where: { id: session.id } })).legacyUnassignedSeconds).toBe(3000)
  })

  it('open and close are idempotent, preserve legacy, and create one resumed segment', async () => {
    const { session } = await fixture()
    await prisma.focusSession.update({ where: { id: session.id }, data: { state: 'running', pausedAt: null } })
    await prisma.$transaction(async (tx) => { await openPeriod(tx, session.id, at(70)); await openPeriod(tx, session.id, at(75)) })
    await prisma.$transaction(async (tx) => { await closePeriod(tx, session.id, at(100)); await closePeriod(tx, session.id, at(120)) })
    expect(await prisma.workPeriod.findMany({ where: { sessionId: session.id }, orderBy: { startedAt: 'asc' }, select: { startedAt: true, endedAt: true } })).toEqual([period(0, 60), period(70, 100)])
    await prisma.focusSession.update({ where: { id: session.id }, data: { reminderPolicy: 0 } })
    await prisma.$transaction((tx) => openPeriod(tx, session.id, at(130)))
    expect(await prisma.workPeriod.count({ where: { sessionId: session.id } })).toBe(2)
  })
})
