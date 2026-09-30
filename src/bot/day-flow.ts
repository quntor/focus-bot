import type { Prisma, User } from '@prisma/client'
import { logEvent } from '../analytics/log.js'
import { addDays, dayKey, daysBetween, weekStart } from '../lib/day.js'
import { nextLocalTime, parseClock } from '../lib/time.js'
import { cancelPending, enqueue } from '../outbox/queue.js'
import { creditCountedSession } from '../retention/credit.js'
import { DAYS_OFF_PER_WEEK, isCounted } from '../retention/rules.js'
import { transition } from '../session/fsm.js'
import { cb } from './callbacks.js'
import { reply, type Ctx } from './context.js'
import { activeSession, askIntent, openCollecting } from './session-flow.js'
import { buildTaskStartPrompt } from './tasks.js'
import { T, hhmm, type DaySummary } from './texts.js'
import type { Keyboard } from '../tg/client.js'

const MIN = 60_000
export const POSTPONE_MINUTES = 30
export const DECLINES_BEFORE_ASK = 3
const EVENING_CLOCK = { h: 19, m: 0 }

const morningClock = (user: User) => parseClock(user.morningTime) ?? { h: 10, m: 0 }

export async function buildSummary(db: Prisma.TransactionClient, user: User, day: string): Promise<DaySummary> {
  // Сессии дня — по дню пользователя. Берём с запасом по времени и фильтруем
  // по ключу дня в поясе пользователя: сутки сервера тут ни при чём.
  const since = new Date(Date.parse(`${day}T00:00:00Z`) - 36 * 60 * MIN)
  const sessions = await db.focusSession.findMany({
    where: { userId: user.id, createdAt: { gte: since }, state: { in: ['finished', 'abandoned'] } },
    select: {
      id: true,
      state: true,
      outcome: true,
      counted: true,
      startedAt: true,
      finishedAt: true,
      pausedSeconds: true,
      task: { select: { id: true, title: true } },
    },
  })
  const today = sessions.filter((s) => s.finishedAt && dayKey(s.finishedAt, user.timezone) === day)
  const finished = today.filter((s) => s.state === 'finished')
  const durationByTask = new Map<string, number>()
  const sessionIds = today.map((session) => session.id)
  const manualAllocations = sessionIds.length === 0
    ? []
    : await db.taskTimeAllocation.findMany({
        where: { userId: user.id, sessionId: { in: sessionIds } },
        select: { sessionId: true, taskId: true, seconds: true },
      })
  const allocationsBySession = new Map<string, typeof manualAllocations>()
  for (const allocation of manualAllocations) {
    const allocations = allocationsBySession.get(allocation.sessionId) ?? []
    allocations.push(allocation)
    allocationsBySession.set(allocation.sessionId, allocations)
  }
  const timelineEvents = sessionIds.length === 0
    ? []
    : await db.event.findMany({
        where: {
          subjectId: user.subjectId,
          sessionId: { in: sessionIds },
          type: { in: ['session_started', 'intent_parsed', 'task_selected', 'task_switched', 'session_paused', 'session_resumed'] },
        },
        select: { id: true, sessionId: true, type: true, payload: true, createdAt: true },
        orderBy: { id: 'asc' },
      })
  const eventsBySession = new Map<string, typeof timelineEvents>()
  for (const event of timelineEvents) {
    if (!event.sessionId) continue
    const events = eventsBySession.get(event.sessionId) ?? []
    events.push(event)
    eventsBySession.set(event.sessionId, events)
  }
  const payloadId = (payload: Prisma.JsonValue | null, key: string): string | null => {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
    const value = (payload as Record<string, unknown>)[key]
    return typeof value === 'string' ? value : null
  }
  const payloadBoolean = (payload: Prisma.JsonValue | null, key: string): boolean => {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false
    return (payload as Record<string, unknown>)[key] === true
  }
  const addDuration = (taskId: string, duration: number) => {
    if (duration <= 0) return
    durationByTask.set(taskId, (durationByTask.get(taskId) ?? 0) + duration)
  }
  for (const session of today) {
    if (!session.startedAt || !session.finishedAt) continue
    const allocations = allocationsBySession.get(session.id) ?? []
    if (allocations.length > 0) {
      for (const allocation of allocations) addDuration(allocation.taskId, allocation.seconds * 1000)
      continue
    }
    const events = eventsBySession.get(session.id) ?? []
    let cursor = session.startedAt
    let periodStart = session.startedAt
    let taskId: string | null = null
    let paused = false
    let hasTaskTimeline = false
    for (const event of events) {
      const at = new Date(Math.min(session.finishedAt.getTime(), Math.max(cursor.getTime(), event.createdAt.getTime())))
      if (!paused && taskId) addDuration(taskId, at.getTime() - cursor.getTime())
      if (event.type === 'session_started' || event.type === 'intent_parsed' || event.type === 'task_selected') {
        const selectedTaskId = payloadId(event.payload, 'task_id')
        if (taskId === null && selectedTaskId && payloadBoolean(event.payload, 'from_period_start')) {
          addDuration(selectedTaskId, at.getTime() - periodStart.getTime())
        }
        taskId = selectedTaskId
        if (taskId) hasTaskTimeline = true
      } else if (event.type === 'task_switched') {
        taskId = payloadId(event.payload, 'to_task_id')
        if (taskId) hasTaskTimeline = true
      } else if (event.type === 'session_paused') {
        paused = true
      } else if (event.type === 'session_resumed') {
        paused = false
        periodStart = at
      }
      cursor = at
      if (event.createdAt >= session.finishedAt) break
    }
    if (hasTaskTimeline) {
      if (!paused && taskId) addDuration(taskId, session.finishedAt.getTime() - cursor.getTime())
    } else if (session.task) {
      // Совместимость со старыми сессиями без событий маршрутизации задач.
      addDuration(
        session.task.id,
        Math.max(0, session.finishedAt.getTime() - session.startedAt.getTime() - session.pausedSeconds * 1000),
      )
    }
  }
  const completionEvents = await db.event.findMany({
    where: { subjectId: user.subjectId, dayKey: day, type: 'task_completed' },
    select: { payload: true },
  })
  const completedIds = [...new Set(completionEvents.flatMap((event) => {
    const payload = event.payload
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return []
    const taskId = (payload as Record<string, unknown>).task_id
    return typeof taskId === 'string' ? [taskId] : []
  }))]
  const taskIds = [...new Set([...durationByTask.keys(), ...completedIds])]
  const summaryTasks = taskIds.length === 0
    ? []
    : await db.task.findMany({ where: { userId: user.id, id: { in: taskIds } }, select: { id: true, title: true } })
  const completed = new Set(completedIds)
  const taskTimes = summaryTasks
    .map((task) => ({
      title: task.title,
      minutes: Math.floor((durationByTask.get(task.id) ?? 0) / MIN),
      completed: completed.has(task.id),
    }))
    .sort((left, right) => right.minutes - left.minutes || left.title.localeCompare(right.title, 'ru'))
  const goal = await db.dailyGoal.findUnique({ where: { userId_dayKey: { userId: user.id, dayKey: day } } })
  const streak = await db.streak.findUnique({ where: { userId: user.id } })
  const points = await db.pointsEntry.aggregate({ where: { userId: user.id, dayKey: day }, _sum: { amount: true } })

  // Неделя к неделе: эта неделя с понедельника по сегодня против прошлой по тот
  // же день недели. Лучшая неделя — больше любой прошлой целиком.
  const week = weekStart(day)
  const offset = daysBetween(week, day)
  const entries = await db.pointsEntry.findMany({ where: { userId: user.id }, select: { dayKey: true, amount: true } })
  const byWeek = new Map<string, number>()
  for (const e of entries) byWeek.set(weekStart(e.dayKey), (byWeek.get(weekStart(e.dayKey)) ?? 0) + e.amount)
  const weekPoints = byWeek.get(week) ?? 0
  const prevStart = addDays(week, -7)
  const prevEnd = addDays(prevStart, offset)
  const hadPrev = [...byWeek.keys()].some((w) => w < week)
  const prevWeekPoints = hadPrev
    ? entries.filter((e) => e.dayKey >= prevStart && e.dayKey <= prevEnd).reduce((a, e) => a + e.amount, 0)
    : null
  const previous = [...byWeek.entries()].filter(([w]) => w < week).map(([, v]) => v)
  const bestWeek = previous.length > 0 && weekPoints > Math.max(...previous)

  // Мягкая метрика рядом с серией: сколько из последних 7 дней были активными.
  // Один пропуск почти не мешает привычке (Lally et al., 2010) — пусть это видно.
  const recent = await db.dailyGoal.count({
    where: { userId: user.id, dayKey: { gte: addDays(day, -6), lte: day }, completedSessions: { gt: 0 } },
  })

  return {
    sessions: finished.length,
    done: finished.filter((s) => s.outcome === 'done').length,
    notDone: finished.filter((s) => s.outcome === 'not_done').length,
    other: finished.filter((s) => s.outcome === 'other').length,
    abandoned: today.length - finished.length,
    counted: finished.filter((s) => s.counted).length,
    target: goal?.targetSessions ?? null,
    streak: streak?.current ?? 0,
    points: points._sum.amount ?? 0,
    weekPoints,
    prevWeekPoints,
    bestWeek,
    activeDays: recent,
    taskTimes,
  }
}

function nextMeetingKeyboard(user: User): Keyboard {
  return [
    [{ text: T.tomorrowAt(user.morningTime), data: cb('meet', null, 'morning') }],
    [{ text: T.customTime, data: cb('meet', null, 'custom') }],
    [{ text: T.dayOffButton, data: cb('off', null, 'tomorrow') }],
  ]
}

// Объявленный выходной — только на завтра (объявляется накануне), не больше
// одного в календарную неделю. Встреча переносится на послезавтра утром.
export async function planDayOff(ctx: Ctx, user: User): Promise<void> {
  const now = ctx.now()
  const tomorrow = addDays(dayKey(now, user.timezone), 1)
  const week = weekStart(tomorrow)
  // Послезавтра утром: начало завтрашних суток, затем начало следующих.
  const startTomorrow = nextLocalTime(user.timezone, { h: 0, m: 0 }, now)
  const startAfter = nextLocalTime(user.timezone, { h: 0, m: 0 }, startTomorrow)
  const at = nextLocalTime(user.timezone, morningClock(user), new Date(startAfter.getTime() - 60_000))
  const ok = await ctx.db.$transaction(async (tx) => {
    // Блокировка пользователя: два одновременных нажатия не должны дать два
    // выходных на одной неделе.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'dayoff:' + user.id}))`
    const taken = await tx.dayOff.count({ where: { userId: user.id, dayKey: { gte: week, lte: addDays(week, 6) } } })
    if (taken >= DAYS_OFF_PER_WEEK) return false
    await tx.dayOff.create({ data: { userId: user.id, dayKey: tomorrow, createdAt: now } })
    await logEvent(tx, user.id, 'day_off_planned', { day_key: tomorrow }, { at: now })
    await putMeeting(tx, user, at, { defaulted: false, morning: true })
    await tx.user.update({ where: { id: user.id }, data: { pendingInput: 'none' } })
    return true
  })
  if (!ok) return reply(ctx, user, T.dayOffTaken)
  await reply(ctx, user, T.dayOffSet(hhmm(at, user.timezone)))
}

// Одна ждущая встреча на пользователя: новая заменяет прежние.
async function putMeeting(
  tx: Prisma.TransactionClient,
  user: User,
  at: Date,
  opts: { defaulted: boolean; morning: boolean },
): Promise<void> {
  const key = `meeting:${user.id}:${at.getTime()}`
  await cancelPending(tx, { userId: user.id, kind: 'meeting', idempotencyKey: { not: key } })
  const reused = await tx.outboxMessage.updateMany({
    where: { userId: user.id, kind: 'meeting', idempotencyKey: key, status: { in: ['pending', 'canceled'] } },
    data: {
      status: 'pending',
      sendAfter: at,
      payload: { defaulted: opts.defaulted, morning: opts.morning },
      lockedUntil: null,
      sentAt: null,
      attempts: 0,
      lastError: null,
    },
  })
  if (reused.count === 1) return
  await enqueue(tx, {
    userId: user.id,
    kind: 'meeting',
    key,
    sendAfter: at,
    payload: { defaulted: opts.defaulted, morning: opts.morning },
  })
}

// Встреча по умолчанию — завтра утром. Ставится сразу, как только день
// закрывается, чтобы молчание в ответ на «когда встретимся» не обернулось
// тишиной. Выбор человека её заменит.
export async function putDefaultMeeting(tx: Prisma.TransactionClient, user: User, now: Date): Promise<void> {
  if (!user.proactive) return
  await putMeeting(tx, user, nextLocalTime(user.timezone, morningClock(user), now), { defaulted: true, morning: true })
}

// «Всё, на сегодня» — работает всегда и без уговоров, но заканчивается итогом
// дня и назначением следующей встречи. Тишиной — никогда.
export async function closeDay(
  ctx: Ctx,
  user: User,
  via: 'button' | 'command' | 'text' | 'voice',
  options: { meetingAt?: Date } = {},
): Promise<void> {
  const now = ctx.now()
  const day = dayKey(now, user.timezone)
  const summary = await ctx.db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'day:' + user.id}))`
    const active = await tx.focusSession.findFirst({
      where: { userId: user.id, state: { in: ['collecting_intent', 'running', 'paused'] } },
    })
    if (active?.state === 'collecting_intent') {
      await transition(tx, { sessionId: active.id, userId: user.id }, 'collecting_intent', 'cancelled', { finishedAt: now })
      await logEvent(tx, user.id, 'session_cancelled', {}, { at: now, sessionId: active.id })
    } else if (active?.state === 'running' || active?.state === 'paused') {
      const openPauseSeconds =
        active.state === 'paused' && active.pausedAt
          ? Math.floor(Math.max(0, now.getTime() - active.pausedAt.getTime()) / 1000)
          : 0
      const elapsed = active.startedAt
        ? Math.floor(Math.max(0, now.getTime() - active.startedAt.getTime() - (active.pausedSeconds + openPauseSeconds) * 1000) / MIN)
        : 0
      const counted = isCounted('finished', elapsed)
      const early = active.plannedEndAt !== null && now < active.plannedEndAt
      await transition(tx, { sessionId: active.id, userId: user.id }, active.state, 'finished', {
        outcome: 'not_done',
        pausedAt: null,
        pausedSeconds: active.pausedSeconds + openPauseSeconds,
        finishedAt: now,
        counted,
        restChoice: 'day_end',
      })
      await tx.outboxMessage.updateMany({
        where: {
          userId: user.id,
          status: { in: ['pending', 'paused'] },
          OR: [
            { idempotencyKey: { startsWith: `ping:${active.id}` } },
            { idempotencyKey: { startsWith: `session_end:${active.id}` } },
          ],
        },
        data: { status: 'canceled' },
      })
      await logEvent(
        tx,
        user.id,
        'session_completed',
        { session_id: active.id, outcome: 'not_done', elapsed_minutes: elapsed, early, counted },
        { at: now, sessionId: active.id },
      )
      if (counted) await creditCountedSession(tx, { userId: user.id, sessionId: active.id, dayKey: day, at: now })
    }
    await tx.dailyGoal.upsert({
      where: { userId_dayKey: { userId: user.id, dayKey: day } },
      create: { userId: user.id, dayKey: day, summarySentAt: now },
      update: { summarySentAt: now },
    })
    await cancelPending(tx, { userId: user.id, kind: { in: ['summary', 'rest_over', 'meeting'] } })
    await tx.user.update({
      where: { id: user.id },
      data: { pendingInput: options.meetingAt ? 'none' : 'meeting_time_soft', declinesInRow: 0 },
    })
    await logEvent(tx, user.id, 'day_closed', { day_key: day, via }, { at: now })
    if (options.meetingAt) {
      await putMeeting(tx, user, options.meetingAt, { defaulted: false, morning: false })
      await logEvent(
        tx,
        user.id,
        'meeting_scheduled',
        { kind: 'custom', minutes_ahead: Math.max(0, Math.round((options.meetingAt.getTime() - now.getTime()) / MIN)) },
        { at: now },
      )
    } else {
      await putDefaultMeeting(tx, user, now)
    }
    return buildSummary(tx, user, day)
  })
  if (options.meetingAt) {
    const which = dayKey(options.meetingAt, user.timezone) === day ? 'today' : 'tomorrow'
    await reply(ctx, user, `${T.summary(summary)}\n\n${T.meetingSet(hhmm(options.meetingAt, user.timezone), which)}`)
  } else {
    await reply(ctx, user, `${T.summary(summary)}\n\n${T.askNextMeeting}`, nextMeetingKeyboard(user))
  }
}

export async function onSummaryConfirm(ctx: Ctx, user: User, arg: string): Promise<void> {
  const now = ctx.now()
  const day = `${arg.slice(0, 4)}-${arg.slice(4, 6)}-${arg.slice(6, 8)}`
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return reply(ctx, user, T.stale)
  const ok = await ctx.db.$transaction(async (tx) => {
    const res = await tx.dailyGoal.updateMany({
      where: { userId: user.id, dayKey: day, confirmedAt: null },
      data: { confirmedAt: now },
    })
    if (res.count !== 1) return false
    const s = await buildSummary(tx, user, day)
    await tx.user.update({ where: { id: user.id }, data: { pendingInput: 'meeting_time_soft' } })
    await logEvent(tx, user.id, 'daily_summary_confirmed', { day_key: day, sessions: s.sessions }, { at: now })
    return true
  })
  if (!ok) return reply(ctx, user, T.stale)
  await reply(ctx, user, `${T.dayClosed}\n${T.askNextMeeting}`, nextMeetingKeyboard(user))
}

export function laterKeyboard(): Keyboard {
  return [
    [
      { text: T.inHour, data: cb('meet', null, 'h1') },
      { text: T.inTwoHours, data: cb('meet', null, 'h2') },
    ],
    [
      { text: T.evening, data: cb('meet', null, 'evening') },
      { text: T.customTime, data: cb('meet', null, 'custom') },
    ],
  ]
}

export async function askLater(ctx: Ctx, user: User): Promise<void> {
  await reply(ctx, user, T.askLater, laterKeyboard())
}

type MeetingKind = 'morning' | 'in_hours' | 'evening' | 'custom' | 'postpone'

export async function scheduleMeeting(ctx: Ctx, user: User, at: Date, kind: MeetingKind): Promise<void> {
  const now = ctx.now()
  await ctx.db.$transaction(async (tx) => {
    await putMeeting(tx, user, at, { defaulted: false, morning: kind === 'morning' })
    await tx.user.update({ where: { id: user.id }, data: { pendingInput: 'none' } })
    await logEvent(tx, user.id, 'meeting_scheduled', { kind, minutes_ahead: Math.max(0, Math.round((at.getTime() - now.getTime()) / MIN)) }, { at: now })
  })
  const which = dayKey(at, user.timezone) === dayKey(now, user.timezone) ? 'today' : 'tomorrow'
  await reply(ctx, user, T.meetingSet(hhmm(at, user.timezone), which))
}

export async function onMeet(ctx: Ctx, user: User, arg: string): Promise<void> {
  const now = ctx.now()
  if (arg === 'custom') {
    await ctx.db.user.update({ where: { id: user.id }, data: { pendingInput: 'meeting_time' } })
    return reply(ctx, user, T.askCustomTime)
  }
  if (arg === 'h1') return scheduleMeeting(ctx, user, new Date(now.getTime() + 60 * MIN), 'in_hours')
  if (arg === 'h2') return scheduleMeeting(ctx, user, new Date(now.getTime() + 120 * MIN), 'in_hours')
  if (arg === 'evening') return scheduleMeeting(ctx, user, nextLocalTime(user.timezone, EVENING_CLOCK, now), 'evening')
  if (arg === 'morning') return scheduleMeeting(ctx, user, nextLocalTime(user.timezone, morningClock(user), now), 'morning')
  return reply(ctx, user, T.stale)
}

// meeting_time — человек сам нажал «Своё время», ждём время строго.
// meeting_time_soft — вопрос «когда встретимся» после итога дня: принимаем
// только явное время («9:30», «в 9», «завтра в 10»). Любой другой текст
// снимает ожидание и разбирается как обычно — иначе «созвон в 9» стал бы
// встречей, а «застрял» получал бы «Напиши время». false — не наш ответ.
export async function onMeetingTimeText(ctx: Ctx, user: User, text: string, opts: { soft?: boolean } = {}): Promise<boolean> {
  const now = ctx.now()
  const at = opts.soft ? softMeetingAt(text, user, now) : meetingAtFromText(text, user, now)
  if (at) {
    await scheduleMeeting(ctx, user, at, 'custom')
    return true
  }
  if (!opts.soft) {
    await reply(ctx, user, T.askCustomTime)
    return true
  }
  await ctx.db.user.updateMany({ where: { id: user.id, pendingInput: 'meeting_time_soft' }, data: { pendingInput: 'none' } })
  return false
}

function softMeetingAt(text: string, user: User, now: Date): Date | null {
  const normalized = text.toLocaleLowerCase('ru').replace(/ё/g, 'е').replace(/\s+/g, ' ').replace(/[.!]+$/, '').trim()
  const onlyTime = parseClock(normalized) !== null || /^(?:(?:сегодня|завтра)\s+)?(?:в|к)\s*\d{1,2}(?:[:.]\d{2})?$/u.test(normalized)
  return onlyTime ? meetingAtFromText(normalized, user, now) : explicitMeetingAt(text, user, now)
}

function meetingAtFromText(text: string, user: User, now: Date): Date | null {
  const normalized = text.toLocaleLowerCase('ru').replace(/ё/g, 'е').replace(/\s+/g, ' ').trim()
  const hasToday = /(?:^|[^\p{L}\p{N}_])сегодня(?=$|[^\p{L}\p{N}_])/u.test(normalized)
  const hasTomorrow = /(?:^|[^\p{L}\p{N}_])завтра(?=$|[^\p{L}\p{N}_])/u.test(normalized)
  const embedded = /(?:^|\s)(?:в|к)\s*(\d{1,2})(?:[:.](\d{2}))?(?=$|[\s,.!?])/u.exec(normalized)
    ?? /(?:^|\s)(\d{1,2})[:.](\d{2})(?=$|[\s,.!?])/u.exec(normalized)
  const clock = parseClock(normalized) ?? (embedded
    ? parseClock(`${embedded[1] ?? ''}:${embedded[2] ?? '00'}`)
    : null)
  if (!clock) return null

  let at: Date
  if (hasTomorrow) {
    const tomorrow = nextLocalTime(user.timezone, { h: 0, m: 0 }, now)
    at = nextLocalTime(user.timezone, clock, new Date(tomorrow.getTime() - MIN))
  } else {
    at = nextLocalTime(user.timezone, clock, now)
    if (hasToday && dayKey(at, user.timezone) !== dayKey(now, user.timezone)) {
      return null
    }
  }
  return at
}

// В отчёте число само по себе может быть длительностью или частью результата.
// Встречу из той же реплики принимаем только при явном «сегодня/завтра».
export function explicitMeetingAt(text: string, user: User, now: Date): Date | null {
  const normalized = text.toLocaleLowerCase('ru').replace(/ё/g, 'е').replace(/\s+/g, ' ').trim()
  if (!/(?:^|[^\p{L}\p{N}_])(?:сегодня|завтра)(?=$|[^\p{L}\p{N}_])/u.test(normalized)) return null
  return meetingAtFromText(text, user, now)
}

// Кнопки под напоминанием. «Ещё отдохну» сдвигает встречу, а не отменяет её;
// отмена встреч — отдельное действие в настройках. Третий отказ подряд — повод
// спросить вслух.
export function reminderKeyboard(): Keyboard {
  return [[{ text: T.postpone, data: cb('mtg', null, 'postpone') }, { text: T.dayEnd, data: cb('mtg', null, 'day_end') }]]
}

export function declineKeyboard(): Keyboard {
  return [[{ text: T.wantPause, data: cb('dec', null, 'pause') }], [{ text: T.cantStart, data: cb('dec', null, 'stuck') }]]
}

export async function onPostpone(ctx: Ctx, user: User): Promise<void> {
  const now = ctx.now()
  const at = new Date(now.getTime() + POSTPONE_MINUTES * MIN)
  const declines = await ctx.db.$transaction(async (tx) => {
    const updated = await tx.user.update({ where: { id: user.id }, data: { declinesInRow: { increment: 1 } } })
    // Отказ закрывает открытый вопрос «с чего начнёшь».
    await tx.focusSession.updateMany({
      where: { userId: user.id, state: 'collecting_intent', intentText: null },
      data: { state: 'cancelled', finishedAt: now },
    })
    await logEvent(tx, user.id, 'meeting_answered', { response: 'postpone' }, { at: now })
    if (updated.declinesInRow >= DECLINES_BEFORE_ASK) {
      await tx.user.update({ where: { id: user.id }, data: { declinesInRow: 0 } })
      await cancelPending(tx, { userId: user.id, kind: { in: ['meeting', 'rest_over'] } })
      await logEvent(tx, user.id, 'decline_check_sent', { declines_in_row: updated.declinesInRow }, { at: now })
      return updated.declinesInRow
    }
    await putMeeting(tx, user, at, { defaulted: false, morning: false })
    await logEvent(tx, user.id, 'meeting_scheduled', { kind: 'postpone', minutes_ahead: POSTPONE_MINUTES }, { at: now })
    return updated.declinesInRow
  })
  if (declines >= DECLINES_BEFORE_ASK) return reply(ctx, user, T.declineCheck, declineKeyboard())
  await reply(ctx, user, T.postponed(hhmm(at, user.timezone)))
}

export async function onDecline(ctx: Ctx, user: User, arg: string): Promise<void> {
  const now = ctx.now()
  if (arg === 'pause') {
    const at = nextLocalTime(user.timezone, morningClock(user), now)
    await ctx.db.$transaction(async (tx) => {
      await cancelPending(tx, { userId: user.id, kind: { in: ['meeting', 'rest_over'] } })
      await putMeeting(tx, user, at, { defaulted: false, morning: true })
      await logEvent(tx, user.id, 'meeting_scheduled', { kind: 'morning', minutes_ahead: Math.round((at.getTime() - now.getTime()) / MIN) }, { at: now })
    })
    return reply(ctx, user, T.pauseSet(hhmm(at, user.timezone)))
  }
  if (arg === 'stuck') return askIntent(ctx, user, { preset: { minutes: 10 }, prefix: T.tinyStep.replace(/\s*С чего начнёшь\?$/, '') })
  return reply(ctx, user, T.stale)
}

export function goalKeyboard(): Keyboard {
  return [
    [1, 2, 3, 4, 5].map((n) => ({ text: String(n), data: cb('goal', null, String(n)) })),
    [{ text: T.later, data: cb('mtg', null, 'postpone') }],
  ]
}

export async function onGoal(ctx: Ctx, user: User, arg: string): Promise<void> {
  const now = ctx.now()
  const target = Number(arg)
  if (!Number.isInteger(target) || target < 1 || target > 20) return reply(ctx, user, T.stale)
  const day = dayKey(now, user.timezone)
  // Очки за цель — только когда её выполнила засчитанная сессия
  // (src/retention/credit.ts). Цель, поставленная задним числом, когда сессий уже
  // хватает, — не цель, а подпись к сделанному: очков за неё нет.
  await ctx.db.$transaction(async (tx) => {
    await tx.dailyGoal.upsert({
      where: { userId_dayKey: { userId: user.id, dayKey: day } },
      create: { userId: user.id, dayKey: day, targetSessions: target },
      update: { targetSessions: target },
    })
    await logEvent(tx, user.id, 'daily_goal_set', { target_sessions: target }, { at: now })
  })
  const active = await activeSession(ctx, user.id)
  if (!active || active.state === 'collecting_intent') {
    const prompt = await buildTaskStartPrompt(ctx, user, T.goalSet(target))
    if (prompt) {
      await openCollecting(ctx, user.id)
      return reply(ctx, user, prompt.text, prompt.keyboard)
    }
  }
  await askIntent(ctx, user, { prefix: T.goalSet(target).replace(/\s*С чего начнёшь\?$/, '') })
}
