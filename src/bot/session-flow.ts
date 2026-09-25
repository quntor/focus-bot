import { Prisma, type FocusSession, type User } from '@prisma/client'
import { logEvent } from '../analytics/log.js'
import { dayKey } from '../lib/day.js'
import { nextLocalTime, parseClock } from '../lib/time.js'
import { parseIntent } from '../llm/intent.js'
import { parseReport } from '../llm/report.js'
import { cancelPending, enqueue } from '../outbox/queue.js'
import { creditCountedSession, type Credit } from '../retention/credit.js'
import { isCounted } from '../retention/rules.js'
import { adjust, parseNamedMinutes, proposeMinutes, restFor } from '../session/duration.js'
import { ACTIVE_STATES, StaleTransition, transition, type Outcome } from '../session/fsm.js'
import { PRESETS, isTechnique, type Technique } from '../session/technique.js'
import { cb } from './callbacks.js'
import { reply, type Ctx } from './context.js'
import { T, hhmm } from './texts.js'
import type { Keyboard } from '../tg/client.js'

const MIN = 60_000
const INTENT_MAX = 500
const REPORT_MAX = 1000
// Отчёт принимается к сессии, закрытой не раньше, чем столько назад.
const REPORT_WINDOW_MS = 2 * 60 * MIN

// Каждый запрос сессий фильтруется по владельцу. Владелец — только userId из
// проверенного апдейта; id сессии из callback_data — лишь указатель.
export function ownedSession(ctx: Ctx, userId: string, sessionId: string) {
  return ctx.db.focusSession.findFirst({ where: { id: sessionId, userId } })
}

export function activeSession(ctx: Ctx, userId: string) {
  return ctx.db.focusSession.findFirst({ where: { userId, state: { in: [...ACTIVE_STATES] } } })
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'
}

// Открыть сессию в collecting_intent или вернуть уже активную. Одна активная
// сессия на пользователя держится частичным уникальным индексом: из двух
// одновременных /focus вторая получит нарушение уникальности и возьмёт первую.
export async function openCollecting(
  ctx: Ctx,
  userId: string,
  preset?: { minutes: number },
): Promise<FocusSession> {
  const existing = await activeSession(ctx, userId)
  if (existing) return existing
  try {
    return await ctx.db.focusSession.create({
      data: {
        userId,
        state: 'collecting_intent',
        createdAt: ctx.now(),
        ...(preset ? { plannedMinutes: preset.minutes, minutesSource: 'bot' } : {}),
      },
    })
  } catch (error) {
    if (!isUniqueViolation(error)) throw error
    const active = await activeSession(ctx, userId)
    if (!active) throw error
    return active
  }
}

async function intentHint(ctx: Ctx, userId: string): Promise<string | null> {
  const task = await ctx.db.task.findFirst({
    where: { userId, status: 'active', nextStep: { not: null } },
    orderBy: { lastSessionAt: 'desc' },
  })
  return task?.nextStep ? T.nextStepHint(task.title, task.nextStep) : null
}

function endText(ctx: Ctx, user: User, session: FocusSession): string | null {
  return session.plannedEndAt ? hhmm(session.plannedEndAt, user.timezone) : null
}

function activeElapsedMs(session: FocusSession, now: Date): number {
  if (!session.startedAt) return 0
  const currentPause = session.state === 'paused' && session.pausedAt ? Math.max(0, now.getTime() - session.pausedAt.getTime()) : 0
  return Math.max(0, now.getTime() - session.startedAt.getTime() - session.pausedSeconds * 1000 - currentPause)
}

export function activeElapsedMinutes(session: FocusSession, now: Date): number {
  return Math.floor(activeElapsedMs(session, now) / MIN)
}

function sessionHistory(ctx: Ctx, userId: string) {
  return ctx.db.focusSession.findMany({
    where: { userId, state: { in: ['finished', 'abandoned'] } },
    orderBy: { createdAt: 'desc' },
    take: 5,
    select: { state: true, plannedMinutes: true, counted: true, minutesAdjusted: true, restChoice: true },
  })
}

function runningEditKeyboard(sessionId: string): Keyboard {
  return [
    [{ text: T.changeRunningWork, data: cb('run', sessionId, 'work') }],
    [{ text: T.changeRunningDuration, data: cb('run', sessionId, 'duration') }],
  ]
}

// «С чего начнёшь?» — с ритуалом и подсказкой следующего шага. Если сессия уже
// идёт, вместо вопроса — где мы сейчас.
export async function askIntent(ctx: Ctx, user: User, opts: { continue?: boolean; preset?: { minutes: number }; prefix?: string } = {}) {
  const session = await openCollecting(ctx, user.id, opts.preset)
  if (session.state === 'running') {
    await reply(ctx, user, T.alreadyRunning(endText(ctx, user, session)))
    return
  }
  if (session.state === 'paused') {
    await reply(ctx, user, T.breakChoice)
    return
  }
  const text = opts.continue
    ? T.askContinue
    : T.askIntent(user.ritualText, await intentHint(ctx, user.id))
  await reply(ctx, user, opts.prefix ? `${opts.prefix}\n${text}` : text)
}

// Постоянная кнопка — это действие, а не вход в анкету. Сессия стартует сразу:
// работа наследуется из последней реальной сессии, длительность берётся тем же
// детерминированным правилом, что и обычное предложение. Всё можно изменить уже
// после старта, но отсутствие ответа не мешает работать и ставить паузу.
export async function onStartButton(ctx: Ctx, user: User): Promise<void> {
  const session = await openCollecting(ctx, user.id)
  if (session.state === 'running') return reply(ctx, user, T.alreadyRunning(endText(ctx, user, session)))
  if (session.state === 'paused') return reply(ctx, user, T.breakChoice)
  if (session.intentText !== null) return startRunning(ctx, user, session.id)

  const previous = await ctx.db.focusSession.findFirst({
    where: { userId: user.id, id: { not: session.id }, state: { in: ['finished', 'abandoned'] }, intentText: { not: null } },
    orderBy: { createdAt: 'desc' },
    select: { intentText: true, taskId: true, scope: true },
  })
  const previousTask = previous?.taskId
    ? await ctx.db.task.findFirst({ where: { id: previous.taskId, userId: user.id, status: 'active' }, select: { id: true } })
    : null
  const technique: Technique = isTechnique(user.technique) ? user.technique : 'auto'
  const minutes =
    session.plannedMinutes ?? (technique === 'auto' ? proposeMinutes(await sessionHistory(ctx, user.id)) : PRESETS[technique].minutes)
  const rest = technique === 'auto' ? restFor(minutes) : PRESETS[technique].rest
  const updated = await ctx.db.focusSession.updateMany({
    where: { id: session.id, userId: user.id, state: 'collecting_intent', intentText: null },
    data: {
      intentText: previous?.intentText ?? null,
      taskId: previousTask?.id ?? null,
      scope: previous?.scope === 'multi_session' ? 'multi_session' : 'step',
      plannedMinutes: minutes,
      minutesSource: 'bot',
      plannedRestMinutes: rest,
      technique,
    },
  })
  if (updated.count !== 1) {
    const active = await activeSession(ctx, user.id)
    if (active?.state === 'collecting_intent' && active.intentText !== null) return startRunning(ctx, user, active.id)
    if (active?.state === 'running') return reply(ctx, user, T.alreadyRunning(endText(ctx, user, active)))
    if (active?.state === 'paused') return reply(ctx, user, T.breakChoice)
    return reply(ctx, user, T.stale)
  }
  await startRunning(ctx, user, session.id)
}

// Выбор из списка задач пропускает повторный LLM-разбор: taskId уже выбран
// человеком кнопкой, а владение проверено запросом по userId.
export async function startTaskSession(ctx: Ctx, user: User, taskId: string): Promise<void> {
  const task = await ctx.db.task.findFirst({ where: { id: taskId, userId: user.id, status: 'active' } })
  if (!task) return reply(ctx, user, T.stale)

  const session = await openCollecting(ctx, user.id)
  if (session.state === 'running') return reply(ctx, user, T.alreadyRunning(endText(ctx, user, session)))
  if (session.state === 'paused') return reply(ctx, user, T.breakChoice)

  const technique: Technique = isTechnique(user.technique) ? user.technique : 'auto'
  const minutes = technique === 'auto' ? proposeMinutes(await sessionHistory(ctx, user.id)) : PRESETS[technique].minutes
  const rest = technique === 'auto' ? restFor(minutes) : PRESETS[technique].rest
  const updated = await ctx.db.$transaction(async (tx) => {
    const res = await tx.focusSession.updateMany({
      where: { id: session.id, userId: user.id, state: 'collecting_intent' },
      data: {
        intentText: task.title,
        taskId: task.id,
        scope: 'step',
        plannedMinutes: minutes,
        minutesSource: 'bot',
        plannedRestMinutes: rest,
        technique,
      },
    })
    if (res.count === 1) await logEvent(tx, user.id, 'task_selected', { task_id: task.id }, { at: ctx.now(), sessionId: session.id })
    return res.count
  })
  if (updated !== 1) return reply(ctx, user, T.stale)
  await startRunning(ctx, user, session.id)
}

// Свободный текст вне сессии — это ответ на «с чего начнёшь». Отдельной команды
// для старта не нужно: /focus существует для тех, кто привык к командам.
export async function onIntentText(ctx: Ctx, user: User, text: string): Promise<void> {
  const session = await openCollecting(ctx, user.id)
  if (session.state === 'running') {
    await reply(ctx, user, T.alreadyRunning(endText(ctx, user, session)))
    return
  }
  if (session.state === 'paused') {
    await reply(ctx, user, T.breakChoice)
    return
  }
  // Предложение длины уже показано — новый текст уточняет намерение, а не
  // начинает второе. Одно намерение за раз.
  await handleIntent(ctx, user, session, text.trim().slice(0, INTENT_MAX))
}

function lengthKeyboard(sessionId: string): Keyboard {
  return [
    [{ text: T.ok, data: cb('len', sessionId, 'ok') }],
    [
      { text: T.shorter, data: cb('len', sessionId, 'down') },
      { text: T.longer, data: cb('len', sessionId, 'up') },
    ],
    [{ text: T.cancel, data: cb('len', sessionId, 'cancel') }],
  ]
}

async function handleIntent(ctx: Ctx, user: User, session: FocusSession, text: string): Promise<void> {
  const now = ctx.now()
  const technique: Technique = isTechnique(user.technique) ? user.technique : 'auto'
  const named = parseNamedMinutes(text)
  // Уточнение большого намерения: задача и масштаб уже известны, модель второй
  // раз не зовём — меняется только формулировка шага.
  const refining = session.intentText !== null

  let taskId = session.taskId
  let title = text.slice(0, 80)
  let scope: 'step' | 'multi_session' = (session.scope as 'step' | 'multi_session' | null) ?? 'step'
  let llmUsed = false
  let failure: 'disabled' | 'error' | 'timeout' | 'invalid' | null = null

  if (!refining) {
    // В промт уходят задачи только этого пользователя — выборка по userId.
    const tasks = await ctx.db.task.findMany({
      where: { userId: user.id, status: 'active' },
      orderBy: { lastSessionAt: 'desc' },
      take: 20,
      select: { id: true, title: true },
    })
    const parsed = await parseIntent(ctx.llm, { text, tasks, profile: user.profileText })
    taskId = parsed.result.taskId
    title = parsed.result.title
    scope = parsed.result.scope
    llmUsed = parsed.result.llmUsed
    failure = parsed.failure && !parsed.failure.ok ? parsed.failure.reason : null
  }

  // Длина: названная человеком — принимается; иначе техника; иначе предложение
  // по истории; предустановка (крошечный шаг после отказов) — важнее истории.
  let minutes: number | null
  let source: 'user' | 'bot'
  if (named !== null) {
    minutes = named
    source = 'user'
  } else if (session.plannedMinutes !== null && session.minutesSource === 'bot' && !refining) {
    minutes = session.plannedMinutes
    source = 'bot'
  } else if (technique !== 'auto') {
    minutes = PRESETS[technique].minutes
    source = 'bot'
  } else {
    minutes = proposeMinutes(await sessionHistory(ctx, user.id))
    source = 'bot'
  }
  const rest = technique !== 'auto' && named === null ? PRESETS[technique].rest : restFor(minutes)

  try {
    await ctx.db.$transaction(async (tx) => {
      let isNewTask = false
      if (!refining && taskId === null) {
        const task = await tx.task.create({ data: { userId: user.id, title, createdAt: now } })
        taskId = task.id
        isNewTask = true
      }
      const res = await tx.focusSession.updateMany({
        where: { id: session.id, userId: user.id, state: 'collecting_intent' },
        data: {
          intentText: text,
          taskId,
          scope,
          plannedMinutes: minutes,
          minutesSource: source,
          plannedRestMinutes: rest,
          technique,
        },
      })
      if (res.count !== 1) throw new StaleTransition()
      await logEvent(tx, user.id, 'intent_submitted', { length_chars: text.length, named_minutes: named !== null }, { at: now, sessionId: session.id })
      if (!refining) {
        await logEvent(tx, user.id, 'intent_parsed', { llm_used: llmUsed, task_id: taskId, is_new_task: isNewTask, scope }, { at: now, sessionId: session.id })
        if (failure) await logEvent(tx, user.id, 'llm_fallback', { stage: 'intent', reason: failure }, { at: now })
      }
    })
  } catch (error) {
    if (error instanceof StaleTransition) return reply(ctx, user, T.stale)
    throw error
  }

  if (!refining && scope === 'multi_session') {
    await reply(ctx, user, T.bigIntent(minutes))
    return
  }
  if (named !== null) {
    // Время названо — без переспрашивания: проигнорировать «за час» и
    // предложить своё было бы абсурдом.
    await startRunning(ctx, user, session.id)
    return
  }
  const text2 =
    minutes === null ? T.proposeFree : technique !== 'auto' ? T.proposeTechnique(minutes, rest) : T.propose(minutes, rest)
  await reply(ctx, user, text2, lengthKeyboard(session.id))
}

export async function onLength(ctx: Ctx, user: User, sessionId: string, arg: string): Promise<void> {
  const session = await ownedSession(ctx, user.id, sessionId)
  if (!session || session.state !== 'collecting_intent' || session.intentText === null) {
    return reply(ctx, user, T.stale)
  }
  const now = ctx.now()
  if (arg === 'ok') return startRunning(ctx, user, session.id)
  if (arg === 'cancel') {
    try {
      await ctx.db.$transaction(async (tx) => {
        await transition(tx, { sessionId, userId: user.id }, 'collecting_intent', 'cancelled', { finishedAt: now })
        await logEvent(tx, user.id, 'session_cancelled', {}, { at: now, sessionId })
      })
    } catch (error) {
      if (error instanceof StaleTransition) return reply(ctx, user, T.stale)
      throw error
    }
    return reply(ctx, user, T.cancelled)
  }
  if (arg !== 'up' && arg !== 'down') return reply(ctx, user, T.stale)
  if (session.plannedMinutes === null) return reply(ctx, user, T.stale)

  const minutes = adjust(session.plannedMinutes, arg)
  const rest = restFor(minutes)
  const res = await ctx.db.$transaction(async (tx) => {
    const r = await tx.focusSession.updateMany({
      where: { id: sessionId, userId: user.id, state: 'collecting_intent' },
      data: { plannedMinutes: minutes, plannedRestMinutes: rest, minutesAdjusted: arg },
    })
    if (r.count === 1) {
      await logEvent(tx, user.id, 'session_length_adjusted', { direction: arg, planned_minutes: minutes }, { at: now, sessionId })
    }
    return r.count
  })
  if (res !== 1) return reply(ctx, user, T.stale)
  await reply(ctx, user, T.propose(minutes, rest), lengthKeyboard(sessionId))
}

// Старт таймера. Пинг и конец сессии — строки в outbox, а не таймеры процесса:
// перезапуск не должен терять отложенные сообщения.
export async function startRunning(ctx: Ctx, user: User, sessionId: string): Promise<void> {
  const now = ctx.now()
  const session = await ownedSession(ctx, user.id, sessionId)
  if (!session || session.state !== 'collecting_intent') return reply(ctx, user, T.stale)

  const technique: Technique = isTechnique(session.technique ?? '') ? (session.technique as Technique) : 'auto'
  const minutes = session.plannedMinutes
  const rest = session.plannedRestMinutes ?? restFor(minutes)
  const plannedEndAt = minutes === null ? null : new Date(now.getTime() + minutes * MIN)

  // Пинг: свободный режим — раз в полчаса; помодоро — без пинга; остальное — в
  // середине, если человек не выключил пинги и сессия не совсем короткая.
  let pingAt: Date | null = null
  if (user.pingsEnabled) {
    if (minutes === null) pingAt = new Date(now.getTime() + 30 * MIN)
    else if (technique !== 'pomodoro' && minutes >= 20) pingAt = new Date(now.getTime() + (minutes / 2) * MIN)
  }

  try {
    await ctx.db.$transaction(async (tx) => {
      await transition(tx, { sessionId, userId: user.id }, 'collecting_intent', 'running', { startedAt: now, plannedEndAt, pingAt })
      if (pingAt) await enqueue(tx, { userId: user.id, kind: 'ping', key: `ping:${sessionId}:1`, sendAfter: pingAt, payload: { sessionId, n: 1 } })
      if (plannedEndAt) await enqueue(tx, { userId: user.id, kind: 'session_end', key: `session_end:${sessionId}`, sendAfter: plannedEndAt, payload: { sessionId } })
      if (session.taskId) {
        await tx.task.updateMany({
          where: { id: session.taskId, userId: user.id },
          data: { sessionsCount: { increment: 1 }, lastSessionAt: now },
        })
      }
      // Человек начал сам — ждущие напоминания на ближайшие часы уже не нужны.
      await cancelPending(tx, { userId: user.id, kind: 'rest_over' })
      await cancelPending(tx, { userId: user.id, kind: 'meeting', sendAfter: { lte: new Date(now.getTime() + 3 * 60 * MIN) } })
      await tx.user.update({ where: { id: user.id }, data: { declinesInRow: 0 } })
      await scheduleSummary(tx, user, now)
      const isNewTask = session.taskId !== null && (await tx.task.count({ where: { id: session.taskId, sessionsCount: 1 } })) === 1
      await logEvent(
        tx,
        user.id,
        'session_started',
        {
          task_id: session.taskId,
          is_new_task: isNewTask,
          planned_minutes: minutes,
          planned_rest_minutes: rest,
          minutes_source: session.minutesSource === 'user' ? 'user' : 'bot',
          technique,
          scope: session.scope === 'multi_session' ? 'multi_session' : 'step',
        },
        { at: now, sessionId },
      )
    })
  } catch (error) {
    if (error instanceof StaleTransition) return reply(ctx, user, T.stale)
    throw error
  }
  await reply(
    ctx,
    user,
    T.started(minutes, rest, plannedEndAt ? hhmm(plannedEndAt, user.timezone) : null, session.intentText),
    runningEditKeyboard(session.id),
  )
}

export async function onRunningEdit(
  ctx: Ctx,
  user: User,
  sessionId: string,
  field: 'work' | 'duration',
): Promise<void> {
  const session = await ownedSession(ctx, user.id, sessionId)
  if (!session || session.state !== 'running') return reply(ctx, user, T.stale)
  await ctx.db.user.update({
    where: { id: user.id },
    data: { pendingInput: `running_${field}:${sessionId}` },
  })
  await reply(ctx, user, field === 'work' ? T.askRunningWork : T.askRunningDuration)
}

export async function onRunningWorkText(ctx: Ctx, user: User, sessionId: string, raw: string): Promise<void> {
  const text = raw.trim().slice(0, INTENT_MAX)
  if (!text) return reply(ctx, user, T.askRunningWork)
  const session = await ownedSession(ctx, user.id, sessionId)
  if (!session || session.state !== 'running') {
    await ctx.db.user.update({ where: { id: user.id }, data: { pendingInput: 'none' } })
    return reply(ctx, user, T.stale)
  }

  const tasks = await ctx.db.task.findMany({
    where: { userId: user.id, status: 'active' },
    orderBy: { lastSessionAt: 'desc' },
    take: 20,
    select: { id: true, title: true },
  })
  const parsed = await parseIntent(ctx.llm, { text, tasks, profile: user.profileText })
  const failure = parsed.failure && !parsed.failure.ok ? parsed.failure.reason : null

  try {
    await ctx.db.$transaction(async (tx) => {
      let taskId = parsed.result.taskId
      let isNewTask = false
      if (taskId === null) {
        const task = await tx.task.create({ data: { userId: user.id, title: parsed.result.title, createdAt: ctx.now() } })
        taskId = task.id
        isNewTask = true
      }
      const changed = await tx.focusSession.updateMany({
        where: {
          id: session.id,
          userId: user.id,
          state: 'running',
          intentText: session.intentText,
          taskId: session.taskId,
        },
        data: { intentText: text, taskId, scope: parsed.result.scope },
      })
      if (changed.count !== 1) throw new StaleTransition()
      if (taskId !== session.taskId) {
        if (session.taskId) {
          await tx.task.updateMany({
            where: { id: session.taskId, userId: user.id, sessionsCount: { gt: 0 } },
            data: { sessionsCount: { decrement: 1 } },
          })
        }
        await tx.task.updateMany({
          where: { id: taskId, userId: user.id },
          data: { sessionsCount: { increment: 1 }, lastSessionAt: ctx.now() },
        })
      }
      await tx.user.update({ where: { id: user.id }, data: { pendingInput: 'none' } })
      await logEvent(tx, user.id, 'intent_submitted', { length_chars: text.length, named_minutes: false }, { at: ctx.now(), sessionId })
      await logEvent(
        tx,
        user.id,
        'intent_parsed',
        { llm_used: parsed.result.llmUsed, task_id: taskId, is_new_task: isNewTask, scope: parsed.result.scope },
        { at: ctx.now(), sessionId },
      )
      if (failure) await logEvent(tx, user.id, 'llm_fallback', { stage: 'intent', reason: failure }, { at: ctx.now() })
    })
  } catch (error) {
    if (error instanceof StaleTransition) {
      await ctx.db.user.update({ where: { id: user.id }, data: { pendingInput: 'none' } })
      return reply(ctx, user, T.stale)
    }
    throw error
  }
  await reply(ctx, user, T.runningWorkUpdated(text), runningEditKeyboard(session.id))
}

export async function onRunningDurationText(ctx: Ctx, user: User, sessionId: string, text: string): Promise<void> {
  const minutes = parseNamedMinutes(text)
  if (minutes === null) return reply(ctx, user, T.badRunningDuration)
  const now = ctx.now()
  const session = await ownedSession(ctx, user.id, sessionId)
  if (!session || session.state !== 'running' || !session.startedAt) {
    await ctx.db.user.update({ where: { id: user.id }, data: { pendingInput: 'none' } })
    return reply(ctx, user, T.stale)
  }

  const elapsedMs = activeElapsedMs(session, now)
  const remainingMs = minutes * MIN - elapsedMs
  if (remainingMs <= 0) return reply(ctx, user, T.runningDurationTooShort(Math.max(1, Math.ceil(elapsedMs / MIN))))
  const plannedEndAt = new Date(now.getTime() + remainingMs)
  const rest = restFor(minutes)
  const technique: Technique = isTechnique(session.technique ?? '') ? (session.technique as Technique) : 'auto'
  let pingAt: Date | null = null
  if (user.pingsEnabled && session.pingAnsweredAt === null && technique !== 'pomodoro' && minutes >= 20) {
    const candidate = new Date(session.startedAt.getTime() + session.pausedSeconds * 1000 + (minutes / 2) * MIN)
    if (candidate > now) pingAt = candidate
  }

  try {
    await ctx.db.$transaction(async (tx) => {
      const endKey = `session_end:${session.id}`
      const endMessage = await tx.outboxMessage.findUnique({ where: { idempotencyKey: endKey } })
      if (endMessage) {
        const updated = await tx.outboxMessage.updateMany({
          where: { id: endMessage.id, userId: user.id, status: { in: ['pending', 'paused', 'canceled'] } },
          data: { status: 'pending', sendAfter: plannedEndAt, lockedUntil: null },
        })
        if (updated.count !== 1) throw new StaleTransition()
      } else {
        await enqueue(tx, { userId: user.id, kind: 'session_end', key: endKey, sendAfter: plannedEndAt, payload: { sessionId: session.id } })
      }

      const pingKey = `ping:${session.id}:1`
      const pingMessage = await tx.outboxMessage.findUnique({ where: { idempotencyKey: pingKey } })
      if (pingAt && pingMessage) {
        const updated = await tx.outboxMessage.updateMany({
          where: { id: pingMessage.id, userId: user.id, status: { in: ['pending', 'paused', 'canceled'] } },
          data: { status: 'pending', sendAfter: pingAt, lockedUntil: null },
        })
        if (updated.count !== 1) pingAt = null
      } else if (pingAt) {
        await enqueue(tx, { userId: user.id, kind: 'ping', key: pingKey, sendAfter: pingAt, payload: { sessionId: session.id, n: 1 } })
      } else {
        await cancelPending(tx, { userId: user.id, idempotencyKey: pingKey })
      }

      const changed = await tx.focusSession.updateMany({
        where: {
          id: session.id,
          userId: user.id,
          state: 'running',
          plannedMinutes: session.plannedMinutes,
          plannedEndAt: session.plannedEndAt,
        },
        data: {
          plannedMinutes: minutes,
          minutesSource: 'user',
          minutesAdjusted: session.plannedMinutes !== null && minutes < session.plannedMinutes ? 'down' : 'up',
          plannedRestMinutes: rest,
          plannedEndAt,
          pingAt,
        },
      })
      if (changed.count !== 1) throw new StaleTransition()
      await tx.user.update({ where: { id: user.id }, data: { pendingInput: 'none' } })
      await logEvent(
        tx,
        user.id,
        'session_length_adjusted',
        { direction: session.plannedMinutes !== null && minutes < session.plannedMinutes ? 'down' : 'up', planned_minutes: minutes },
        { at: now, sessionId },
      )
    })
  } catch (error) {
    if (error instanceof StaleTransition) {
      await ctx.db.user.update({ where: { id: user.id }, data: { pendingInput: 'none' } })
      return reply(ctx, user, T.stale)
    }
    throw error
  }
  await reply(ctx, user, T.runningDurationUpdated(minutes, hhmm(plannedEndAt, user.timezone)), runningEditKeyboard(session.id))
}

// Вечерняя сводка ставится с первой сессией дня. Бот пишет первым, только пока
// человек это не выключил.
export async function scheduleSummary(tx: Prisma.TransactionClient, user: User, now: Date): Promise<void> {
  if (!user.proactive) return
  const day = dayKey(now, user.timezone)
  const clock = parseClock(user.eveningTime) ?? { h: 21, m: 0 }
  const at = nextLocalTime(user.timezone, clock, now)
  if (dayKey(at, user.timezone) !== day) return
  await enqueue(tx, { userId: user.id, kind: 'summary', key: `summary:${user.id}:${day}`, sendAfter: at, payload: { dayKey: day } })
}

export async function onPing(ctx: Ctx, user: User, sessionId: string, arg: string): Promise<void> {
  const now = ctx.now()
  const session = await ownedSession(ctx, user.id, sessionId)
  if (!session || session.state !== 'running' || !session.pingAt) return reply(ctx, user, T.stale)
  const answered = await ctx.db.$transaction(async (tx) => {
    const res = await tx.focusSession.updateMany({
      where: { id: sessionId, userId: user.id, state: 'running', pingAnsweredAt: null },
      data: { pingAnsweredAt: now, pingsMissed: 0 },
    })
    if (res.count !== 1) return false
    const latency = Math.max(0, Math.round((now.getTime() - session.pingAt!.getTime()) / 1000))
    await logEvent(tx, user.id, 'ping_answered', { session_id: sessionId, latency_sec: latency }, { at: now, sessionId })
    return true
  })
  if (!answered) return reply(ctx, user, T.stale)
  await reply(ctx, user, arg === 'back' ? T.pingAnsweredBack : T.pingAnsweredHere)
}

export function outcomeKeyboard(sessionId: string): Keyboard {
  return [
    [{ text: T.outcome.done, data: cb('out', sessionId, 'done') }],
    [{ text: T.outcome.not_done, data: cb('out', sessionId, 'not_done') }],
    [{ text: T.outcome.other, data: cb('out', sessionId, 'other') }],
  ]
}

export async function onDone(ctx: Ctx, user: User): Promise<void> {
  const session = await activeSession(ctx, user.id)
  if (session?.state === 'paused') return reply(ctx, user, T.breakChoice)
  if (!session || session.state !== 'running') return reply(ctx, user, T.nothingRunning)
  await reply(ctx, user, T.sessionEndEarly, outcomeKeyboard(session.id))
}

export async function onOutcome(ctx: Ctx, user: User, sessionId: string, outcome: Outcome): Promise<void> {
  const now = ctx.now()
  const session = await ownedSession(ctx, user.id, sessionId)
  if (!session || session.state !== 'running' || !session.startedAt) return reply(ctx, user, T.stale)

  const elapsed = Math.floor(activeElapsedMs(session, now) / MIN)
  const counted = isCounted('finished', elapsed)
  const early = session.plannedEndAt !== null && now < session.plannedEndAt
  const day = dayKey(now, user.timezone)

  let credit: Credit | null = null
  try {
    await ctx.db.$transaction(async (tx) => {
      await transition(tx, { sessionId, userId: user.id }, 'running', 'finished', { outcome, finishedAt: now, counted })
      await cancelPending(tx, { userId: user.id, idempotencyKey: { startsWith: `ping:${sessionId}` } })
      await cancelPending(tx, { userId: user.id, idempotencyKey: `session_end:${sessionId}` })
      await logEvent(tx, user.id, 'session_completed', { session_id: sessionId, outcome, elapsed_minutes: elapsed, early, counted }, { at: now, sessionId })
      if (counted) credit = await creditCountedSession(tx, { userId: user.id, sessionId, dayKey: day, at: now })
      await tx.user.update({ where: { id: user.id }, data: { pendingInput: 'report_text' } })
    })
  } catch (error) {
    if (error instanceof StaleTransition) return reply(ctx, user, T.stale)
    throw error
  }
  await reply(ctx, user, [...creditLines(credit), T.askReport].join('\n'), [[{ text: T.skip, data: cb('skiprep', sessionId) }]])
}

// Что человек узнаёт сразу после засчитанной сессии: возвращение, серия
// (починка, разрыв без вины, заморозка), прогресс к цели дня.
function creditLines(credit: Credit | null): string[] {
  if (!credit) return []
  const lines: string[] = []
  if (credit.comeback) lines.push(T.comeback)
  if (credit.streak.repaired) lines.push(T.streakRepaired(credit.streak.current))
  else if (credit.streak.broken) lines.push(T.streakBroken(credit.streak.broken.previous, credit.streak.broken.repairable))
  else if (credit.streak.frozenDays > 0) lines.push(T.freezeUsed(credit.streak.frozenDays, credit.streak.freezesLeft))
  if (credit.goalReached) lines.push(T.goalReached)
  else if (credit.goal.target !== null && credit.goal.completed < credit.goal.target) lines.push(T.goalProgress(credit.goal.completed, credit.goal.target))
  return lines
}

// Отчёт — пара слов после исхода. Привязывается к последней закрытой сессии
// этого же пользователя, у которой отчёта ещё нет.
export async function onReportText(ctx: Ctx, user: User, text: string): Promise<boolean> {
  const since = new Date(ctx.now().getTime() - REPORT_WINDOW_MS)
  const session = await ctx.db.focusSession.findFirst({
    where: { userId: user.id, state: 'finished', reportText: null, restChoice: null, finishedAt: { gte: since } },
    orderBy: { finishedAt: 'desc' },
  })
  if (!session) {
    await ctx.db.user.update({ where: { id: user.id }, data: { pendingInput: 'none' } })
    return false
  }
  await finalizeReport(ctx, user, session, text.trim().slice(0, REPORT_MAX))
  return true
}

export async function onSkipReport(ctx: Ctx, user: User, sessionId: string): Promise<void> {
  const session = await ownedSession(ctx, user.id, sessionId)
  if (!session || session.state !== 'finished' || session.restChoice !== null || session.progress !== null) {
    return reply(ctx, user, T.stale)
  }
  await finalizeReport(ctx, user, session, null)
}

const STUCK_AFTER = 3

async function finalizeReport(ctx: Ctx, user: User, session: FocusSession, text: string | null): Promise<void> {
  const now = ctx.now()
  const outcome = (session.outcome ?? 'other') as Outcome
  if (text !== null) {
    const saved = await ctx.db.$transaction(async (tx) => {
      const res = await tx.focusSession.updateMany({
        where: { id: session.id, userId: user.id, reportText: null },
        data: { reportText: text },
      })
      if (res.count !== 1) return false
      await tx.user.update({ where: { id: user.id }, data: { pendingInput: 'none' } })
      await logEvent(tx, user.id, 'report_submitted', { session_id: session.id, length_chars: text.length }, { at: now, sessionId: session.id })
      return true
    })
    if (!saved) return reply(ctx, user, T.stale)
  }

  // Модель зовётся вне транзакции: медленный ответ не должен держать блокировки.
  const parsed = await parseReport(ctx.llm, { intent: session.intentText, outcome, report: text })
  const failure = parsed.failure && !parsed.failure.ok ? parsed.failure.reason : null
  let stuckTask: string | null = null

  await ctx.db.$transaction(async (tx) => {
    const res = await tx.focusSession.updateMany({
      where: { id: session.id, userId: user.id, progress: null },
      data: { progress: parsed.result.progress },
    })
    if (res.count !== 1) return
    if (text === null) await tx.user.update({ where: { id: user.id }, data: { pendingInput: 'none' } })
    await logEvent(tx, user.id, 'report_parsed', { session_id: session.id, llm_used: parsed.result.llmUsed, progress: parsed.result.progress }, { at: now, sessionId: session.id })
    if (failure) await logEvent(tx, user.id, 'llm_fallback', { stage: 'report', reason: failure }, { at: now })

    if (session.taskId && parsed.result.progress) {
      const task = await tx.task.findFirst({ where: { id: session.taskId, userId: user.id } })
      if (task) {
        if (parsed.result.progress === 'moved') {
          await tx.task.update({
            where: { id: task.id },
            data: { lastProgressAt: now, sessionsSinceProgress: 0, ...(parsed.result.nextStep ? { nextStep: parsed.result.nextStep } : {}) },
          })
        } else {
          const n = task.sessionsSinceProgress + 1
          await tx.task.update({ where: { id: task.id }, data: { sessionsSinceProgress: n } })
          if (n === STUCK_AFTER) {
            stuckTask = task.title
            await logEvent(tx, user.id, 'task_stuck_detected', { task_id: task.id, sessions_without_progress: n }, { at: now })
          }
        }
      }
    }
  })

  if (stuckTask) await reply(ctx, user, T.stuck(stuckTask))
  await askRest(ctx, user, session)
}

// После нескольких сессий бот сам замечает рисунок и предлагает технику одной
// репликой. Решает код по истории, а не модель; предлагает один раз.
export const SUGGEST_AFTER_COUNTED = 3

async function maybeSuggestTechnique(ctx: Ctx, user: User): Promise<void> {
  const fresh = await ctx.db.user.findUniqueOrThrow({ where: { id: user.id } })
  if (fresh.technique !== 'auto' || fresh.techniqueSuggestedAt || fresh.countedSessions < SUGGEST_AFTER_COUNTED) return
  const history = await ctx.db.focusSession.findMany({
    where: { userId: user.id, state: { in: ['finished', 'abandoned'] } },
    orderBy: { createdAt: 'desc' },
    take: 3,
    select: { state: true, counted: true, minutesAdjusted: true, restChoice: true },
  })
  const extends3 = history.length === 3 && history.every((s) => s.counted && (s.minutesAdjusted === 'up' || s.restChoice === 'continue'))
  const drops = history.slice(0, 3).filter((s) => s.state === 'abandoned' || s.minutesAdjusted === 'down').length >= 2
  const pick = extends3 ? 'long' : drops ? 'pomodoro' : null
  if (!pick) return
  const marked = await ctx.db.user.updateMany({ where: { id: user.id, techniqueSuggestedAt: null }, data: { techniqueSuggestedAt: ctx.now() } })
  if (marked.count !== 1) return
  await reply(ctx, user, pick === 'long' ? T.suggestLong : T.suggestShort, [
    [{ text: T.tryIt, data: cb('tech', null, pick) }],
    [{ text: T.keepAsIs, data: cb('tech', null, 'auto') }],
  ])
}

// После отчёта отдых предлагается, а не назначается. Если ответа нет, через
// время отдыха всё равно придёт «отдохнул?» — бот не замолкает.
async function askRest(ctx: Ctx, user: User, session: FocusSession): Promise<void> {
  const now = ctx.now()
  const rest = session.plannedRestMinutes ?? restFor(session.plannedMinutes)
  await enqueue(ctx.db, {
    userId: user.id,
    kind: 'rest_over',
    key: `rest_over:${session.id}`,
    sendAfter: new Date(now.getTime() + rest * MIN),
    payload: { sessionId: session.id },
  })
  await reply(ctx, user, T.askRest(rest), [
    [{ text: T.restOk(rest), data: cb('rest', session.id, 'rest') }],
    [{ text: T.restContinue, data: cb('rest', session.id, 'continue') }],
    [{ text: T.restLater, data: cb('rest', session.id, 'later') }],
    [{ text: T.dayEnd, data: cb('rest', session.id, 'day_end') }],
  ])
}

export type RestChoice = 'rest' | 'continue' | 'later' | 'day_end'

export async function onRest(
  ctx: Ctx,
  user: User,
  sessionId: string,
  choice: RestChoice,
  next: { later: () => Promise<void>; dayEnd: () => Promise<void> },
): Promise<void> {
  const now = ctx.now()
  const session = await ownedSession(ctx, user.id, sessionId)
  if (!session || session.state !== 'finished' || session.restChoice !== null) return reply(ctx, user, T.stale)
  const rest = session.plannedRestMinutes ?? restFor(session.plannedMinutes)

  const ok = await ctx.db.$transaction(async (tx) => {
    const res = await tx.focusSession.updateMany({
      where: { id: sessionId, userId: user.id, restChoice: null },
      data: { restChoice: choice },
    })
    if (res.count !== 1) return false
    await tx.user.update({ where: { id: user.id }, data: { pendingInput: 'none' } })
    await logEvent(tx, user.id, 'rest_chosen', { session_id: sessionId, choice, rest_minutes: choice === 'rest' ? rest : 0 }, { at: now, sessionId })
    if (choice === 'rest') {
      // Отдых отсчитывается от выбора, а не от вопроса.
      await tx.outboxMessage.updateMany({
        where: { userId: user.id, idempotencyKey: `rest_over:${sessionId}`, status: 'pending' },
        data: { sendAfter: new Date(now.getTime() + rest * MIN) },
      })
    } else {
      await cancelPending(tx, { userId: user.id, idempotencyKey: `rest_over:${sessionId}` })
    }
    return true
  })
  if (!ok) return reply(ctx, user, T.stale)
  // Рисунок сессий виден только после выбора: «сразу дальше» — часть сигнала.
  await maybeSuggestTechnique(ctx, user)

  if (choice === 'rest') return reply(ctx, user, T.restStarted(hhmm(new Date(now.getTime() + rest * MIN), user.timezone)))
  if (choice === 'continue') return askIntent(ctx, user, { continue: true })
  if (choice === 'later') return next.later()
  return next.dayEnd()
}

// «Перерыв» не требует заранее решать судьбу текущей сессии. Таймер и сообщения
// замораживаются; выбор продолжить или начать заново появляется уже на перерыве.
export async function onBreak(ctx: Ctx, user: User): Promise<void> {
  const now = ctx.now()
  const session = await activeSession(ctx, user.id)
  if (!session || session.state === 'collecting_intent') return reply(ctx, user, T.nothingToPause)
  if (session.state === 'paused') return reply(ctx, user, T.breakChoice)

  try {
    await ctx.db.$transaction(async (tx) => {
      await transition(tx, { sessionId: session.id, userId: user.id }, 'running', 'paused', { pausedAt: now })
      await tx.outboxMessage.updateMany({
        where: {
          userId: user.id,
          status: 'pending',
          OR: [{ idempotencyKey: { startsWith: `ping:${session.id}` } }, { idempotencyKey: `session_end:${session.id}` }],
        },
        data: { status: 'paused' },
      })
      await tx.user.update({ where: { id: user.id }, data: { pendingInput: 'none' } })
      await logEvent(tx, user.id, 'session_paused', { session_id: session.id, elapsed_minutes: Math.floor(activeElapsedMs(session, now) / MIN) }, { at: now, sessionId: session.id })
    })
  } catch (error) {
    if (error instanceof StaleTransition) return reply(ctx, user, T.stale)
    throw error
  }
  await reply(ctx, user, `${T.breakStarted}\n${T.breakChoice}`)
}

export async function onResume(ctx: Ctx, user: User): Promise<void> {
  const now = ctx.now()
  const session = await activeSession(ctx, user.id)
  if (!session || session.state !== 'paused' || !session.pausedAt) return reply(ctx, user, T.nothingPaused)

  const pauseMs = Math.max(0, now.getTime() - session.pausedAt.getTime())
  const plannedEndAt = session.plannedEndAt ? new Date(session.plannedEndAt.getTime() + pauseMs) : null
  const pingAt = session.pingAt && session.pingAt > session.pausedAt ? new Date(session.pingAt.getTime() + pauseMs) : session.pingAt

  try {
    await ctx.db.$transaction(async (tx) => {
      await transition(tx, { sessionId: session.id, userId: user.id }, 'paused', 'running', {
        pausedAt: null,
        pausedSeconds: { increment: Math.floor(pauseMs / 1000) },
        plannedEndAt,
        pingAt,
      })
      const held = await tx.outboxMessage.findMany({
        where: {
          userId: user.id,
          status: 'paused',
          OR: [{ idempotencyKey: { startsWith: `ping:${session.id}` } }, { idempotencyKey: `session_end:${session.id}` }],
        },
        select: { id: true, sendAfter: true },
      })
      for (const message of held) {
        await tx.outboxMessage.update({
          where: { id: message.id },
          data: { status: 'pending', sendAfter: new Date(message.sendAfter.getTime() + pauseMs) },
        })
      }
      await logEvent(tx, user.id, 'session_resumed', { session_id: session.id, paused_minutes: Math.floor(pauseMs / MIN) }, { at: now, sessionId: session.id })
    })
  } catch (error) {
    if (error instanceof StaleTransition) return reply(ctx, user, T.stale)
    throw error
  }
  await reply(ctx, user, T.breakResumed(plannedEndAt ? hhmm(plannedEndAt, user.timezone) : null))
}

export async function onNewAfterBreak(ctx: Ctx, user: User): Promise<void> {
  const now = ctx.now()
  const session = await activeSession(ctx, user.id)
  if (!session || session.state !== 'paused' || !session.pausedAt) return reply(ctx, user, T.nothingPaused)
  const pauseMs = Math.max(0, now.getTime() - session.pausedAt.getTime())
  const elapsed = Math.floor(activeElapsedMs(session, now) / MIN)

  try {
    await ctx.db.$transaction(async (tx) => {
      await transition(tx, { sessionId: session.id, userId: user.id }, 'paused', 'abandoned', {
        pausedAt: null,
        pausedSeconds: { increment: Math.floor(pauseMs / 1000) },
        finishedAt: now,
        abandonReason: 'new_session',
      })
      await tx.outboxMessage.updateMany({
        where: {
          userId: user.id,
          status: { in: ['pending', 'paused'] },
          OR: [{ idempotencyKey: { startsWith: `ping:${session.id}` } }, { idempotencyKey: `session_end:${session.id}` }],
        },
        data: { status: 'canceled' },
      })
      await tx.user.update({ where: { id: user.id }, data: { pendingInput: 'none' } })
      await logEvent(tx, user.id, 'session_stopped', { session_id: session.id, elapsed_minutes: elapsed }, { at: now, sessionId: session.id })
    })
  } catch (error) {
    if (error instanceof StaleTransition) return reply(ctx, user, T.stale)
    throw error
  }
  await onStartButton(ctx, user)
}

// /stop: running/paused — брошена (очков не даёт), collecting_intent — отменена.
export async function onStop(ctx: Ctx, user: User): Promise<void> {
  const now = ctx.now()
  const session = await activeSession(ctx, user.id)
  if (!session) return reply(ctx, user, T.nothingRunning)
  try {
    await ctx.db.$transaction(async (tx) => {
      if (session.state === 'running' || session.state === 'paused') {
        const elapsed = Math.floor(activeElapsedMs(session, now) / MIN)
        const pauseMs = session.state === 'paused' && session.pausedAt ? Math.max(0, now.getTime() - session.pausedAt.getTime()) : 0
        await transition(tx, { sessionId: session.id, userId: user.id }, session.state, 'abandoned', {
          finishedAt: now,
          abandonReason: 'stop',
          ...(session.state === 'paused' ? { pausedAt: null, pausedSeconds: { increment: Math.floor(pauseMs / 1000) } } : {}),
        })
        await logEvent(tx, user.id, 'session_stopped', { session_id: session.id, elapsed_minutes: elapsed }, { at: now, sessionId: session.id })
      } else {
        await transition(tx, { sessionId: session.id, userId: user.id }, 'collecting_intent', 'cancelled', { finishedAt: now })
        await logEvent(tx, user.id, 'session_cancelled', {}, { at: now, sessionId: session.id })
      }
      await cancelPending(tx, { userId: user.id, idempotencyKey: { startsWith: `ping:${session.id}` } })
      await cancelPending(tx, { userId: user.id, idempotencyKey: `session_end:${session.id}` })
      await tx.outboxMessage.updateMany({
        where: {
          userId: user.id,
          status: 'paused',
          OR: [{ idempotencyKey: { startsWith: `ping:${session.id}` } }, { idempotencyKey: `session_end:${session.id}` }],
        },
        data: { status: 'canceled' },
      })
      await tx.user.update({ where: { id: user.id }, data: { pendingInput: 'none' } })
    })
  } catch (error) {
    if (error instanceof StaleTransition) return reply(ctx, user, T.stale)
    throw error
  }
  await reply(ctx, user, session.state === 'running' || session.state === 'paused' ? T.stopped : T.cancelled)
}
