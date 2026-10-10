import { beforeEach, describe, expect, it } from 'vitest'
import { hasDb, prisma, resetDb } from '../test/db.js'
import { makeBot } from '../test/bot.js'
import { runOutboxOnce } from '../outbox/worker.js'
import { sweepOnce } from '../jobs/sweeper.js'
import { buildSummary } from '../bot/day-flow.js'

const A = 902027
const MIN = 60_000
const INITIAL = new Date('2026-10-05T07:00:00Z')

describe.skipIf(!hasDb)('new policy webhook and worker flows', () => {
  beforeEach(resetDb)
  async function setup() {
    const bot = makeBot({ now: INITIAL })
    bot.ctx.remindersEnabled = true
    bot.ctx.reminderUserIds = [String(A)]
    await bot.setupOnboarded(A)
    const user = await prisma.user.findUniqueOrThrow({ where: { tgId: BigInt(A) } })
    return { bot, user }
  }
  async function start() {
    const f = await setup()
    await f.bot.textAs(A, 'Начать сессию', {"text":"Начать сессию","route":"control","action":"focus","value":null,"followUp":null})
    const session = await prisma.focusSession.findFirstOrThrow({ where: { userId: f.user.id, state: 'running' } })
    return { ...f, session }
  }
  const chainFor = (userId: string) => prisma.reminderChain.findFirstOrThrow({ where: { userId, status: 'active' } })

  it('morning asks once per local day and work answer offers explicit start without starting work', async () => {
    const { bot, user } = await setup()
    // Onboarding opens preparation; a morning question belongs to idle users.
    await prisma.focusSession.updateMany({ where: { userId: user.id, state: 'collecting_intent' }, data: { state: 'cancelled', finishedAt: bot.now() } })
    await prisma.user.update({ where: { id: user.id }, data: { pendingInput: 'none' } })
    await sweepOnce(bot.ctx)
    await runOutboxOnce(bot.ctx)
    expect(await prisma.focusSession.count({ where: { userId: user.id, state: 'running' } })).toBe(0)
    expect((await chainFor(user.id)).nextDueAt).toEqual(new Date('2026-10-06T07:00:00Z'))
    bot.advance(60)
    await sweepOnce(bot.ctx)
    await runOutboxOnce(bot.ctx)
    expect(bot.textsTo(A).filter((text) => /выходной/.test(text))).toHaveLength(1)
    await bot.press(A, bot.lastButton(A, 'morning:', ':work'))
    expect(await prisma.calendarPlan.findUniqueOrThrow({ where: { userId_localDate: { userId: user.id, localDate: '2026-10-05' } } })).toMatchObject({ answer: 'work' })
    expect(await prisma.focusSession.count({ where: { userId: user.id, state: 'running' } })).toBe(0)
    expect(await prisma.workPeriod.count()).toBe(0)
  })

  it('settings move a future morning to the new local hour and timezone atomically', async () => {
    const { bot, user } = await setup()
    await prisma.focusSession.updateMany({ where: { userId: user.id, state: 'collecting_intent' }, data: { state: 'cancelled', finishedAt: bot.now() } })
    await prisma.user.update({ where: { id: user.id }, data: { pendingInput: 'none' } })
    await sweepOnce(bot.ctx)
    await runOutboxOnce(bot.ctx)
    await bot.press(A, bot.lastButton(A, 'morning:', ':off'))
    await sweepOnce(bot.ctx)
    const previous = await chainFor(user.id)
    expect(previous.nextDueAt).toEqual(new Date('2026-10-06T07:00:00Z'))
    await bot.press(A, 'set::morning')
    await bot.textAs(A, '08:00', {"text":"08:00","route":"answer_pending","answer":{"kind":"clock","hour":8,"minute":0,"day":"next"},"followUp":null})
    let current = await chainFor(user.id)
    expect(current.nextDueAt).toEqual(new Date('2026-10-06T05:00:00Z'))
    expect(await prisma.outboxMessage.count({ where: { chainId: previous.id, status: 'pending' } })).toBe(0)
    await bot.press(A, 'set::timezone')
    await bot.textAs(A, '12:00', {"text":"12:00","route":"answer_pending","answer":{"kind":"clock","hour":12,"minute":0,"day":"next"},"followUp":null}) // At07UTC this selects UTC+5.
    current = await chainFor(user.id)
    expect(current.nextDueAt).toEqual(new Date('2026-10-06T03:00:00Z'))
    expect(await prisma.outboxMessage.count({ where: { chainId: current.id, status: 'pending', sendAfter: current.nextDueAt } })).toBe(1)
  })

  it('a report can explicitly allocate the remainder of multi-day timerless physical work', async () => {
    const { bot, user, session } = await start()
    const task = await prisma.task.create({ data: { userId: user.id, title: 'Собрать отчёт' } })
    await prisma.focusSession.update({ where: { id: session.id }, data: { technique: 'free', plannedMinutes: null, plannedEndAt: null } })
    bot.advance(2880)
    await bot.press(A, `out:${session.id}:done`)
    await bot.textAs(A, 'Закончил, остальное на отчёт', { route: 'report', text: 'Закончил, остальное на отчёт', report: { route: 'report', progress: 'moved', next_step: null, continue_now: false, continue_minutes: null, allocations: [{ task: 't1', title: task.title, minutes: null, remainder: true, source: 'остальное на отчёт' }] }, followUp: null })
    expect(await prisma.taskTimeAllocation.findFirstOrThrow({ where: { sessionId: session.id, source: 'report' } })).toMatchObject({ taskId: task.id, seconds: 2880 * 60 })
    expect(await prisma.event.findFirstOrThrow({ where: { sessionId: session.id, type: 'task_time_allocated' } })).toMatchObject({ payload: { allocated_seconds: 2880 * 60, unassigned_seconds: 0 } })
  })

  it('timed work stays running beyond repeated deadlines and sweeper timeout', async () => {
    const { bot, user, session } = await start()
    expect(session.reminderPolicy).toBe(1)
    bot.advance(40)
    await runOutboxOnce(bot.ctx)
    expect(bot.lastButton(A, 'cycle:', ':break')).toMatch(/^cycle:/)
    bot.advance(120)
    await sweepOnce(bot.ctx)
    const sent = bot.tg.sent.length
    await runOutboxOnce(bot.ctx)
    expect(bot.tg.sent.length - sent).toBe(1)
    expect(await prisma.focusSession.findUniqueOrThrow({ where: { id: session.id } })).toMatchObject({ state: 'running', finishedAt: null, outcome: null, counted: false })
    expect(await prisma.workPeriod.count({ where: { sessionId: session.id, endedAt: null } })).toBe(1)
    expect((await chainFor(user.id)).nextDueAt).toEqual(new Date(bot.now().getTime() + 40 * MIN))
    expect(await prisma.pointsEntry.count({ where: { userId: user.id } })).toBe(0)
  })

  it('duration edit after a missed deadline starts a full new interval without changing physical work', async () => {
    const { bot, user, session } = await start()
    bot.advance(90)
    await bot.press(A, bot.lastButton(A, 'run:', ':duration'))
    await bot.textAs(A, '20 минут', {"text":"20 минут","route":"answer_pending","answer":{"kind":"duration","minutes":20},"followUp":null})
    const due = new Date(bot.now().getTime() + 20 * MIN)
    expect(await prisma.focusSession.findUniqueOrThrow({ where: { id: session.id } })).toMatchObject({
      state: 'running', plannedMinutes: 20, plannedEndAt: due, startedAt: INITIAL,
    })
    expect((await chainFor(user.id)).nextDueAt).toEqual(due)
    expect(await prisma.workPeriod.count({ where: { sessionId: session.id, endedAt: null } })).toBe(1)
    expect(await prisma.outboxMessage.count({ where: { userId: user.id, kind: { in: ['ping', 'session_end'] }, status: 'pending' } })).toBe(0)
  })

  it('continue keeps one work period; break and resume keep the session and use full intervals', async () => {
    const { bot, user, session } = await start()
    bot.advance(40)
    await runOutboxOnce(bot.ctx)
    bot.advance(7)
    await bot.press(A, bot.lastButton(A, 'cycle:', ':continue'))
    expect((await chainFor(user.id)).nextDueAt).toEqual(new Date(bot.now().getTime() + 40 * MIN))
    expect(await prisma.workPeriod.count({ where: { sessionId: session.id } })).toBe(1)
    bot.advance(40)
    await runOutboxOnce(bot.ctx)
    await bot.press(A, bot.lastButton(A, 'cycle:', ':break'))
    const pausedAt = bot.now()
    expect(await prisma.focusSession.findUniqueOrThrow({ where: { id: session.id } })).toMatchObject({ state: 'paused', pausedAt })
    bot.advance(10)
    await runOutboxOnce(bot.ctx)
    await bot.press(A, bot.lastButton(A, 'cycle:', ':rest'))
    expect((await prisma.focusSession.findUniqueOrThrow({ where: { id: session.id } })).pausedAt).toEqual(pausedAt)
    bot.advance(10)
    await runOutboxOnce(bot.ctx)
    await bot.press(A, bot.lastButton(A, 'cycle:', ':resume'))
    expect(await prisma.focusSession.findUniqueOrThrow({ where: { id: session.id } })).toMatchObject({ state: 'running', pausedAt: null, pausedSeconds: 1200, plannedEndAt: new Date(bot.now().getTime() + 40 * MIN) })
    expect((await chainFor(user.id)).nextDueAt).toEqual(new Date(bot.now().getTime() + 40 * MIN))
    expect(await prisma.workPeriod.count({ where: { sessionId: session.id } })).toBe(2)
    expect(await prisma.focusSession.count({ where: { userId: user.id } })).toBe(1)
  })

  it('an explicit pause then two-day rest excludes the rest', async () => {
    const { bot, user, session } = await start()
    bot.advance(40)
    await runOutboxOnce(bot.ctx)
    await bot.press(A, bot.lastButton(A, 'cycle:', ':break'))
    expect(await prisma.event.findFirstOrThrow({ where: { sessionId: session.id, type: 'session_paused' } })).toMatchObject({ payload: { elapsed_minutes: 40 } })
    bot.advance(2880)
    await sweepOnce(bot.ctx)
    await runOutboxOnce(bot.ctx)
    expect(await prisma.focusSession.findUniqueOrThrow({ where: { id: session.id } })).toMatchObject({ state: 'paused', finishedAt: null })
    await bot.press(A, bot.lastButton(A, 'cycle:', ':resume'))
    expect(await prisma.event.findFirstOrThrow({ where: { sessionId: session.id, type: 'session_resumed' } })).toMatchObject({ payload: { paused_minutes: 2880 } })
    expect(await prisma.focusSession.findUniqueOrThrow({ where: { id: session.id } })).toMatchObject({ state: 'running', pausedSeconds: 2880 * 60 })
    bot.advance(15)
    await bot.press(A, 'cycle::stop')
    expect(await buildSummary(prisma, user, '2026-10-07')).toMatchObject({ totalMinutes: 55, unassignedMinutes: 55, done: 0, counted: 0 })
    expect(await prisma.pointsEntry.count({ where: { userId: user.id } })).toBe(0)
    expect(await prisma.workPeriod.count({ where: { sessionId: session.id } })).toBe(2)
  })

  it('quiet preserves physical work while stop finishes without outcome or credits', async () => {
    const { bot, user, session } = await start()
    bot.advance(40)
    await runOutboxOnce(bot.ctx)
    await bot.press(A, bot.lastButton(A, 'cycle:', ':quiet'))
    expect(await prisma.focusSession.findUniqueOrThrow({ where: { id: session.id } })).toMatchObject({ state: 'running', finishedAt: null, pausedSeconds: 0 })
    expect(await prisma.workPeriod.findFirstOrThrow({ where: { sessionId: session.id } })).toMatchObject({ endedAt: null })
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).quietUntil).toEqual(new Date('2026-10-05T21:00:00Z'))
    bot.advance(20)
    await bot.press(A, 'cycle::stop')
    expect(await prisma.focusSession.findUniqueOrThrow({ where: { id: session.id } })).toMatchObject({ state: 'finished', finishedAt: bot.now(), outcome: null, counted: false })
    expect(await prisma.workPeriod.findFirstOrThrow({ where: { sessionId: session.id } })).toMatchObject({ endedAt: bot.now() })
    expect(await prisma.pointsEntry.count({ where: { userId: user.id } })).toBe(0)
    expect(await prisma.reminderChain.count({ where: { userId: user.id, kind: 'post_rest', status: 'active' } })).toBe(0)
    const summary = await buildSummary(prisma, user, '2026-10-05')
    expect(summary).toMatchObject({ totalMinutes: 60, unassignedMinutes: 60, taskTimes: [], counted: 0 })
  })

  it('retro callback trims task-switch intervals and repeated receipt does not subtract again', async () => {
    const { bot, user, session } = await start()
    const a = await prisma.task.create({ data: { userId: user.id, title: 'A' } })
    const b = await prisma.task.create({ data: { userId: user.id, title: 'B' } })
    // Explicit routing events are the persisted accounting input; all transitions
    // and the correction still travel through real webhook handlers.
    for (const [offset, type, payload] of [[0, 'task_selected', { task_id: a.id, from_period_start: true }], [30, 'task_switched', { from_task_id: a.id, to_task_id: b.id }]] as const) {
      await prisma.event.create({ data: { subjectId: user.subjectId, sessionId: session.id, type, payload, createdAt: new Date(INITIAL.getTime() + offset * MIN), dayKey: '2026-10-05', userRole: 'active' } })
    }
    bot.advance(60)
    await runOutboxOnce(bot.ctx)
    await bot.press(A, bot.lastButton(A, 'cycle:', ':break'))
    const retroPeriodId = bot.lastButton(A, 'retro:', ':choose').split(':')[1]!
    bot.advance(5)
    await bot.press(A, `retro:${retroPeriodId}:m15`)
    const once = await prisma.focusSession.findUniqueOrThrow({ where: { id: session.id } })
    expect(once.pausedAt).toEqual(new Date(INITIAL.getTime() + 45 * MIN))
    expect(await prisma.taskTimeAllocation.findMany({ where: { sessionId: session.id }, orderBy: { seconds: 'desc' }, select: { taskId: true, seconds: true } })).toEqual([{ taskId: a.id, seconds: 1800 }, { taskId: b.id, seconds: 900 }])
    const correctedChain = await chainFor(user.id)
    bot.advance(3)
    await bot.press(A, `retro:${retroPeriodId}:m15`)
    expect(await chainFor(user.id)).toMatchObject({ revision: correctedChain.revision, nextDueAt: correctedChain.nextDueAt })
    expect(await prisma.focusSession.findUniqueOrThrow({ where: { id: session.id } })).toMatchObject({ pausedAt: once.pausedAt, pausedSeconds: 0 })
    await bot.press(A, 'cycle::stop')
    expect(await buildSummary(prisma, user, '2026-10-05')).toMatchObject({ totalMinutes: 45, unassignedMinutes: 0, taskTimes: [{ title: 'A', minutes: 30, completed: false }, { title: 'B', minutes: 15, completed: false }] })
  })

  it('custom retro time is routed to a specific period and old buttons cannot correct a later pause', async () => {
    const { bot, user, session } = await start()
    bot.advance(60)
    await runOutboxOnce(bot.ctx)
    await bot.press(A, bot.lastButton(A, 'cycle:', ':break'))
    const oldPeriodId = bot.lastButton(A, 'retro:', ':choose').split(':')[1]!
    await bot.press(A, `retro:${oldPeriodId}:custom`)
    await bot.textAs(A, '15', {"text":"15","route":"answer_pending","answer":{"kind":"retro","minutesAgo":15},"followUp":null})
    expect((await prisma.focusSession.findUniqueOrThrow({ where: { id: session.id } })).pausedAt).toEqual(new Date(INITIAL.getTime() + 45 * MIN))
    await bot.press(A, 'cycle::resume')
    bot.advance(20)
    await bot.press(A, 'cycle::break')
    const pausedAt = bot.now()
    const latest = await prisma.workPeriod.findFirstOrThrow({ where: { sessionId: session.id }, orderBy: { startedAt: 'desc' } })
    expect(latest.id).not.toBe(oldPeriodId)
    await bot.press(A, `retro:${oldPeriodId}:m15`)
    expect((await prisma.focusSession.findUniqueOrThrow({ where: { id: session.id } })).pausedAt).toEqual(pausedAt)
    expect((await prisma.workPeriod.findUniqueOrThrow({ where: { id: latest.id } })).correctionId).toBeNull()
    expect((await chainFor(user.id)).kind).toBe('break')
  })

  it('explicit outcome retains normal credit and post-session rest requires an explicit new start', async () => {
    const { bot, user, session } = await start()
    bot.advance(60)
    await bot.press(A, `out:${session.id}:done`)
    expect(await prisma.focusSession.findUniqueOrThrow({ where: { id: session.id } })).toMatchObject({ state: 'finished', outcome: 'done', counted: true, finishedAt: bot.now() })
    expect(await prisma.pointsEntry.count({ where: { userId: user.id, reason: 'session_completed' } })).toBe(1)
    await bot.press(A, `skiprep:${session.id}:`)
    await bot.press(A, `rest:${session.id}:rest`)
    expect((await chainFor(user.id)).kind).toBe('post_rest')
    bot.advance(10)
    await runOutboxOnce(bot.ctx)
    await bot.press(A, bot.lastButton(A, 'cycle:', ':rest'))
    expect((await chainFor(user.id)).nextDueAt).toEqual(new Date(bot.now().getTime() + 10 * MIN))
    expect(await prisma.focusSession.count({ where: { userId: user.id, state: 'running' } })).toBe(0)
    bot.advance(10)
    await runOutboxOnce(bot.ctx)
    await bot.press(A, bot.lastButton(A, 'cycle:', ':resume'))
    expect(await prisma.focusSession.count({ where: { userId: user.id, state: 'running' } })).toBe(0)
    await bot.textAs(A, 'Начать сессию', {"text":"Начать сессию","route":"control","action":"focus","value":null,"followUp":null})
    const next = await prisma.focusSession.findFirstOrThrow({ where: { userId: user.id, state: 'running' } })
    expect(next.id).not.toBe(session.id)
    expect((await chainFor(user.id)).kind).toBe('work')
    expect(await buildSummary(prisma, user, '2026-10-05')).toMatchObject({ totalMinutes: 60, done: 1, counted: 1 })
  })

  it('free/no_ping and non-allowlisted timed sessions keep legacy behavior', async () => {
    const { bot, user } = await setup()
    await prisma.user.update({ where: { id: user.id }, data: { technique: 'free' } })
    await bot.textAs(A, 'глава', {"text":"глава","route":"new_task","intent":{"task":null,"title":"глава","scope":"step"},"minutes":null,"durationSource":null,"followUp":null})
    await bot.press(A, bot.lastButton(A, 'len:', ':ok'))
    const free = await prisma.focusSession.findFirstOrThrow({ where: { userId: user.id, state: 'running' } })
    expect(free).toMatchObject({ reminderPolicy: 0, plannedMinutes: null })
    for (let i = 0; i < 3; i++) { bot.advance(30); await runOutboxOnce(bot.ctx) }
    expect(await prisma.focusSession.findUniqueOrThrow({ where: { id: free.id } })).toMatchObject({ state: 'finished', counted: true })
    expect(await prisma.workPeriod.count({ where: { sessionId: free.id } })).toBe(0)
    const otherId = A + 1
    await bot.setupOnboarded(otherId)
    await bot.textAs(otherId, 'Начать сессию', {"text":"Начать сессию","route":"control","action":"focus","value":null,"followUp":null})
    const legacyUser = await prisma.user.findUniqueOrThrow({ where: { tgId: BigInt(otherId) } })
    const legacy = await prisma.focusSession.findFirstOrThrow({ where: { userId: legacyUser.id, state: 'running' } })
    expect(legacy).toMatchObject({ reminderPolicy: 0, plannedMinutes: 40 })
    expect(await prisma.outboxMessage.count({ where: { userId: legacyUser.id, kind: 'session_end', status: 'pending' } })).toBe(1)
    expect(await prisma.reminderChain.count({ where: { userId: legacyUser.id } })).toBe(0)
    expect(await prisma.workPeriod.count({ where: { sessionId: legacy.id } })).toBe(0)
  })

  it('legacy resume migration preserves 45 prior working minutes plus 15 new minutes', async () => {
    const bot = makeBot({ now: INITIAL })
    await bot.setupOnboarded(A)
    await bot.textAs(A, 'Начать сессию', {"text":"Начать сессию","route":"control","action":"focus","value":null,"followUp":null})
    const user = await prisma.user.findUniqueOrThrow({ where: { tgId: BigInt(A) } })
    const old = await prisma.focusSession.findFirstOrThrow({ where: { userId: user.id, state: 'running' } })
    bot.advance(45)
    await bot.textAs(A, 'Перерыв', {"text":"Перерыв","route":"break","minutes":null,"durationSource":null,"followUp":null})
    bot.advance(15)
    bot.ctx.remindersEnabled = true
    bot.ctx.reminderUserIds = [String(A)]
    await bot.textAs(A, 'Вернуться к работе', {"text":"Вернуться к работе","route":"continue_same","minutes":null,"durationSource":null,"followUp":null})
    expect(await prisma.focusSession.findUniqueOrThrow({ where: { id: old.id } })).toMatchObject({ state: 'running', reminderPolicy: 1 })
    bot.advance(15)
    await bot.press(A, 'cycle::stop')
    expect(await buildSummary(prisma, user, '2026-10-05')).toMatchObject({ totalMinutes: 60, unassignedMinutes: 60 })
    expect(await prisma.workPeriod.findMany({ where: { sessionId: old.id }, orderBy: { startedAt: 'asc' }, select: { startedAt: true, endedAt: true } })).toEqual([
      { startedAt: INITIAL, endedAt: new Date(INITIAL.getTime() + 45 * MIN) },
      { startedAt: new Date(INITIAL.getTime() + 60 * MIN), endedAt: new Date(INITIAL.getTime() + 75 * MIN) },
    ])
  })

  it('legacy resume migration retains previous pauses and task switches', async () => {
    const bot = makeBot({ now: INITIAL })
    await bot.setupOnboarded(A)
    await bot.textAs(A, 'Начать сессию', {"text":"Начать сессию","route":"control","action":"focus","value":null,"followUp":null})
    const user = await prisma.user.findUniqueOrThrow({ where: { tgId: BigInt(A) } })
    const old = await prisma.focusSession.findFirstOrThrow({ where: { userId: user.id, state: 'running' } })
    const a = await prisma.task.create({ data: { userId: user.id, title: 'A' } })
    const b = await prisma.task.create({ data: { userId: user.id, title: 'B' } })
    await prisma.event.create({ data: { subjectId: user.subjectId, sessionId: old.id, type: 'task_selected', payload: { task_id: a.id, from_period_start: true }, createdAt: INITIAL, dayKey: '2026-10-05', userRole: 'active' } })
    bot.advance(20)
    await bot.textAs(A, 'Перерыв', {"text":"Перерыв","route":"break","minutes":null,"durationSource":null,"followUp":null})
    bot.advance(10)
    await bot.textAs(A, 'Вернуться к работе', {"text":"Вернуться к работе","route":"continue_same","minutes":null,"durationSource":null,"followUp":null})
    bot.advance(10)
    await prisma.event.create({ data: { subjectId: user.subjectId, sessionId: old.id, type: 'task_switched', payload: { from_task_id: a.id, to_task_id: b.id }, createdAt: bot.now(), dayKey: '2026-10-05', userRole: 'active' } })
    bot.advance(15)
    await bot.textAs(A, 'Перерыв', {"text":"Перерыв","route":"break","minutes":null,"durationSource":null,"followUp":null})
    bot.advance(15)
    bot.ctx.remindersEnabled = true
    bot.ctx.reminderUserIds = [String(A)]
    await bot.textAs(A, 'Вернуться к работе', {"text":"Вернуться к работе","route":"continue_same","minutes":null,"durationSource":null,"followUp":null})
    bot.advance(15)
    await bot.press(A, 'cycle::stop')
    expect(await buildSummary(prisma, user, '2026-10-05')).toMatchObject({ totalMinutes: 60, unassignedMinutes: 0, taskTimes: [{ title: 'A', minutes: 30, completed: false }, { title: 'B', minutes: 30, completed: false }] })
    expect(await prisma.workPeriod.findMany({ where: { sessionId: old.id }, orderBy: { startedAt: 'asc' }, select: { startedAt: true, endedAt: true } })).toEqual([
      { startedAt: INITIAL, endedAt: new Date(INITIAL.getTime() + 20 * MIN) },
      { startedAt: new Date(INITIAL.getTime() + 30 * MIN), endedAt: new Date(INITIAL.getTime() + 55 * MIN) },
      { startedAt: new Date(INITIAL.getTime() + 70 * MIN), endedAt: new Date(INITIAL.getTime() + 85 * MIN) },
    ])
  })

  it('new-policy summary uses periods even with report allocations and never guesses final task', async () => {
    const { bot, user, session } = await start()
    const task = await prisma.task.create({ data: { userId: user.id, title: 'Report task' } })
    bot.advance(60)
    await bot.press(A, 'cycle::stop')
    await prisma.focusSession.update({ where: { id: session.id }, data: { taskId: task.id, pausedSeconds: 12345 } })
    expect(await buildSummary(prisma, user, '2026-10-05')).toMatchObject({ totalMinutes: 60, unassignedMinutes: 60, taskTimes: [] })
    await prisma.taskTimeAllocation.create({ data: { userId: user.id, sessionId: session.id, taskId: task.id, seconds: 900, source: 'report' } })
    const timelineTask = await prisma.task.create({ data: { userId: user.id, title: 'Superseded timeline' } })
    await prisma.taskTimeAllocation.create({ data: { userId: user.id, sessionId: session.id, taskId: timelineTask.id, seconds: 1200, source: 'timeline' } })
    expect(await buildSummary(prisma, user, '2026-10-05')).toMatchObject({ totalMinutes: 60, unassignedMinutes: 45, taskTimes: [{ title: task.title, minutes: 15, completed: false }] })
  })
})
