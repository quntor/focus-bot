import type { Prisma, User } from '@prisma/client'
import { logEvent } from '../analytics/log.js'
import { addDays, dayKey, daysBetween, weekStart } from '../lib/day.js'
import { nextLocalTime, parseClock } from '../lib/time.js'
import { cancelPending, enqueue } from '../outbox/queue.js'
import { DAYS_OFF_PER_WEEK } from '../retention/rules.js'
import { cb } from './callbacks.js'
import { reply, type Ctx } from './context.js'
import { askIntent } from './session-flow.js'
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
    select: { state: true, outcome: true, counted: true, finishedAt: true },
  })
  const today = sessions.filter((s) => s.finishedAt && dayKey(s.finishedAt, user.timezone) === day)
  const finished = today.filter((s) => s.state === 'finished')
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
export async function closeDay(ctx: Ctx, user: User, via: 'button' | 'command'): Promise<void> {
  const now = ctx.now()
  const day = dayKey(now, user.timezone)
  const summary = await ctx.db.$transaction(async (tx) => {
    await tx.dailyGoal.upsert({
      where: { userId_dayKey: { userId: user.id, dayKey: day } },
      create: { userId: user.id, dayKey: day, summarySentAt: now },
      update: { summarySentAt: now },
    })
    await cancelPending(tx, { userId: user.id, kind: { in: ['summary', 'rest_over', 'meeting'] } })
    await tx.user.update({ where: { id: user.id }, data: { pendingInput: 'none', declinesInRow: 0 } })
    await logEvent(tx, user.id, 'day_closed', { day_key: day, via }, { at: now })
    await putDefaultMeeting(tx, user, now)
    return buildSummary(tx, user, day)
  })
  await reply(ctx, user, `${T.summary(summary)}\n\n${T.askNextMeeting}`, nextMeetingKeyboard(user))
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

export async function onMeetingTimeText(ctx: Ctx, user: User, text: string): Promise<void> {
  const clock = parseClock(text)
  if (!clock) return reply(ctx, user, T.askCustomTime)
  await scheduleMeeting(ctx, user, nextLocalTime(user.timezone, clock, ctx.now()), 'custom')
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
  await askIntent(ctx, user, { prefix: T.goalSet(target).replace(/\s*С чего начнёшь\?$/, '') })
}
