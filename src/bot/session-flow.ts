import { Prisma, type FocusSession, type User } from '@prisma/client'
import { logEvent } from '../analytics/log.js'
import { dayKey } from '../lib/day.js'
import { nextLocalTime, parseClock } from '../lib/time.js'
import { parseIntent } from '../llm/intent.js'
import { parseReport } from '../llm/report.js'
import { parseSessionHelp, type SessionHelpAction } from '../llm/session-help.js'
import { llmMeter } from '../analytics/calls.js'
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

function periodPingAt(user: User, session: FocusSession, now: Date): Date | null {
  if (!user.pingsEnabled) return null
  const minutes = session.plannedMinutes
  if (minutes === null) return new Date(now.getTime() + 30 * MIN)
  const technique: Technique = isTechnique(session.technique ?? '') ? (session.technique as Technique) : 'auto'
  if (technique === 'pomodoro' || minutes < 20) return null
  return new Date(now.getTime() + (minutes / 2) * MIN)
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

function sessionHelpKeyboard(sessionId: string, action: SessionHelpAction): Keyboard {
  const arg = action === 'change_step' ? 'step' : action
  return [[{ text: T.sessionHelpAction[action], data: cb('help', sessionId, arg) }]]
}

export async function onRunningFreeText(ctx: Ctx, user: User, text: string): Promise<boolean> {
  const session = await activeSession(ctx, user.id)
  if (!session || session.state !== 'running') return false
  const now = ctx.now()
  const phase = session.plannedEndAt && now >= session.plannedEndAt ? 'deadline_passed' : 'working'
  const activeTasks = await ctx.db.task.findMany({
    where: { userId: user.id, status: 'active' },
    orderBy: [{ lastSessionAt: 'desc' }, { createdAt: 'asc' }],
    take: 20,
    select: { title: true },
  })
  const parsed = await parseSessionHelp(
    ctx.llm,
    {
      text,
      currentWork: session.intentText,
      activeTasks: activeTasks.map((task) => task.title),
      elapsedMinutes: activeElapsedMinutes(session, now),
      plannedMinutes: session.plannedMinutes,
      phase,
      awaitingDeadlineChoice: user.pendingInput === `session_end:${session.id}`,
    },
    llmMeter(ctx, user.id, 'session_help', session.id),
  )
  if (parsed.result.kind === 'other') return false

  const [current, freshUser] = await Promise.all([
    activeSession(ctx, user.id),
    ctx.db.user.findUnique({ where: { id: user.id }, select: { pendingInput: true } }),
  ])
  if (
    !current ||
    current.id !== session.id ||
    current.state !== 'running' ||
    current.taskId !== session.taskId ||
    current.intentText !== session.intentText ||
    current.plannedEndAt?.getTime() !== session.plannedEndAt?.getTime() ||
    freshUser?.pendingInput !== user.pendingInput
  ) {
    await logEvent(ctx.db, user.id, 'route_stale', { stage: 'tasks' }, { at: ctx.now(), sessionId: session.id })
    await reply(ctx, user, T.stale)
    return true
  }

  if (parsed.result.kind === 'pause') {
    await onBreak(ctx, user)
    return true
  }
  if (parsed.result.kind === 'complete_and_rest') {
    await completeTaskAndRest(ctx, user, current, parsed.result.taskTitle)
    return true
  }

  await logEvent(
    ctx.db,
    user.id,
    'session_help_requested',
    { kind: parsed.result.kind, action: parsed.result.action, llm_used: parsed.result.llmUsed },
    { at: ctx.now(), sessionId: session.id },
  )
  if (parsed.failure && !parsed.failure.ok) {
    await logEvent(ctx.db, user.id, 'llm_fallback', { stage: 'session_help', reason: parsed.failure.reason }, { at: ctx.now(), sessionId: session.id })
  }
  await reply(ctx, user, parsed.result.reply, sessionHelpKeyboard(session.id, parsed.result.action))
  return true
}

async function completeTaskAndRest(
  ctx: Ctx,
  user: User,
  session: FocusSession,
  extractedTitle: string | null,
): Promise<void> {
  const now = ctx.now()
  const cleanTitle = extractedTitle?.replace(/\s+/g, ' ').trim().slice(0, 80) || null
  const rest = session.plannedRestMinutes ?? restFor(session.plannedMinutes)
  const elapsedSeconds = Math.floor(activeElapsedMs(session, now) / 1000)
  const elapsedMinutes = Math.floor(elapsedSeconds / 60)
  const counted = isCounted('finished', elapsedMinutes)
  let taskTitle = cleanTitle

  try {
    await ctx.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${user.id}))`
      const current = await tx.focusSession.findFirst({ where: { id: session.id, userId: user.id, state: 'running' } })
      if (!current || !current.startedAt) throw new StaleTransition()

      const activeTasks = await tx.task.findMany({ where: { userId: user.id, status: 'active' } })
      const normalize = (value: string) => value.toLocaleLowerCase('ru').replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
      let task = cleanTitle
        ? activeTasks.find((candidate) => normalize(candidate.title) === normalize(cleanTitle)) ?? null
        : current.taskId
          ? activeTasks.find((candidate) => candidate.id === current.taskId) ?? null
          : null
      if (!task && cleanTitle) task = await tx.task.create({ data: { userId: user.id, title: cleanTitle, createdAt: now } })
      if (!task) throw new StaleTransition()
      taskTitle = task.title

      const associated = await tx.focusSession.updateMany({
        where: { id: current.id, userId: user.id, state: 'running', taskId: current.taskId },
        data: { taskId: task.id, intentText: task.title },
      })
      if (associated.count !== 1) throw new StaleTransition()
      await transition(tx, { sessionId: current.id, userId: user.id }, 'running', 'finished', {
        outcome: 'done',
        finishedAt: now,
        counted,
        progress: null,
        restChoice: 'rest',
      })
      await cancelPending(tx, { userId: user.id, idempotencyKey: { startsWith: `ping:${current.id}` } })
      await cancelPending(tx, { userId: user.id, idempotencyKey: { startsWith: `session_end:${current.id}` } })

      if (current.taskId && current.taskId !== task.id) {
        await tx.task.updateMany({
          where: { id: current.taskId, userId: user.id, sessionsCount: { gt: 0 } },
          data: { sessionsCount: { decrement: 1 } },
        })
      }
      const marked = await tx.task.updateMany({
        where: { id: task.id, userId: user.id, status: 'active' },
        data: {
          status: 'done',
          lastProgressAt: now,
          lastSessionAt: now,
          sessionsSinceProgress: 0,
          ...(current.taskId === task.id ? {} : { sessionsCount: { increment: 1 } }),
        },
      })
      if (marked.count !== 1) throw new StaleTransition()

      await tx.taskTimeAllocation.deleteMany({ where: { userId: user.id, sessionId: current.id } })
      await tx.taskTimeAllocation.create({
        data: { userId: user.id, sessionId: current.id, taskId: task.id, seconds: elapsedSeconds, source: 'report', createdAt: now, updatedAt: now },
      })
      await enqueue(tx, {
        userId: user.id,
        kind: 'rest_over',
        key: `rest_over:${current.id}`,
        sendAfter: new Date(now.getTime() + rest * MIN),
        payload: { sessionId: current.id },
      })
      await tx.user.update({ where: { id: user.id }, data: { pendingInput: 'report_text' } })
      await logEvent(tx, user.id, 'session_completed', {
        session_id: current.id,
        outcome: 'done',
        elapsed_minutes: elapsedMinutes,
        early: current.plannedEndAt !== null && now < current.plannedEndAt,
        counted,
      }, { at: now, sessionId: current.id })
      await logEvent(tx, user.id, 'task_completed', { task_id: task.id, source: 'text' }, { at: now, sessionId: current.id })
      await logEvent(tx, user.id, 'task_time_allocated', {
        session_id: current.id,
        task_count: 1,
        allocated_seconds: elapsedSeconds,
        unassigned_seconds: 0,
        source: 'report',
      }, { at: now, sessionId: current.id })
      await logEvent(tx, user.id, 'rest_chosen', { session_id: current.id, choice: 'rest', rest_minutes: rest }, { at: now, sessionId: current.id })
      if (counted) await creditCountedSession(tx, { userId: user.id, sessionId: current.id, dayKey: dayKey(now, user.timezone), at: now })
    })
  } catch (error) {
    if (error instanceof StaleTransition) return reply(ctx, user, T.stale)
    throw error
  }

  await reply(
    ctx,
    user,
    `${T.taskCompleted(taskTitle!)}\n${T.restStarted(hhmm(new Date(now.getTime() + rest * MIN), user.timezone))}\nКак прошло? ${T.askReport}`,
    [[{ text: T.skip, data: cb('skiprep', session.id) }]],
  )
}

export async function onSessionHelpAction(
  ctx: Ctx,
  user: User,
  sessionId: string,
  action: 'continue' | 'step' | 'finish',
): Promise<void> {
  const session = await ownedSession(ctx, user.id, sessionId)
  if (!session || session.state !== 'running') return reply(ctx, user, T.stale)
  if (action === 'step') return onRunningEdit(ctx, user, sessionId, 'work')
  if (action === 'finish') return onDone(ctx, user)
  await reply(ctx, user, T.sessionHelpContinue)
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

// Постоянная кнопка запускает обычный помидор без обязательной задачи. Работу
// можно выбрать или назвать уже после старта; первая задача получит время от
// начала текущего рабочего периода.
export async function onStartButton(ctx: Ctx, user: User): Promise<void> {
  await startUnassigned(ctx, user)
}

// Явный быстрый старт не наследует прошлую задачу: человек может сначала
// включить обычный помидор, а назвать работу позже или распределить время в
// отчёте. Общий таймер при этом запускается по обычным настройкам.
export async function startUnassigned(ctx: Ctx, user: User): Promise<void> {
  const session = await openCollecting(ctx, user.id)
  if (session.state === 'running') return reply(ctx, user, T.alreadyRunning(endText(ctx, user, session)))
  if (session.state === 'paused') return reply(ctx, user, T.breakChoice)

  const technique: Technique = isTechnique(user.technique) ? user.technique : 'auto'
  const minutes =
    session.plannedMinutes ?? (technique === 'auto' ? proposeMinutes(await sessionHistory(ctx, user.id)) : PRESETS[technique].minutes)
  const rest = technique === 'auto' ? restFor(minutes) : PRESETS[technique].rest
  const updated = await ctx.db.focusSession.updateMany({
    where: { id: session.id, userId: user.id, state: 'collecting_intent' },
    data: {
      intentText: null,
      taskId: null,
      scope: 'step',
      plannedMinutes: minutes,
      minutesSource: 'bot',
      plannedRestMinutes: rest,
      technique,
    },
  })
  if (updated.count !== 1) return reply(ctx, user, T.stale)
  await startRunning(ctx, user, session.id)
}

// Выбор из списка задач пропускает повторный LLM-разбор. Если таймер уже идёт,
// меняем задачу внутри той же сессии, не сдвигая startedAt и plannedEndAt.
export async function startTaskSession(ctx: Ctx, user: User, taskId: string): Promise<void> {
  const task = await ctx.db.task.findFirst({ where: { id: taskId, userId: user.id, status: 'active' } })
  if (!task) return reply(ctx, user, T.stale)

  const active = await activeSession(ctx, user.id)
  if (active?.state === 'running') {
    try {
      await ctx.db.$transaction(async (tx) => {
        const selected = await tx.task.updateMany({
          where: { id: task.id, userId: user.id, status: 'active' },
          data: { status: 'active' },
        })
        if (selected.count !== 1) throw new StaleTransition()
        const changed = await tx.focusSession.updateMany({
          where: { id: active.id, userId: user.id, state: 'running', taskId: active.taskId },
          data: { intentText: task.title, taskId: task.id, scope: 'step' },
        })
        if (changed.count !== 1) throw new StaleTransition()
        if (active.taskId !== task.id) {
          if (active.taskId) {
            await tx.task.updateMany({
              where: { id: active.taskId, userId: user.id, sessionsCount: { gt: 0 } },
              data: { sessionsCount: { decrement: 1 } },
            })
          }
          await tx.task.updateMany({
            where: { id: task.id, userId: user.id, status: 'active' },
            data: { sessionsCount: { increment: 1 }, lastSessionAt: ctx.now() },
          })
        }
        await logEvent(
          tx,
          user.id,
          'task_selected',
          { task_id: task.id, from_period_start: active.taskId === null },
          { at: ctx.now(), sessionId: active.id },
        )
      })
    } catch (error) {
      if (error instanceof StaleTransition) return reply(ctx, user, T.stale)
      throw error
    }
    await reply(ctx, user, T.taskSelectedRunning(task.title, endText(ctx, user, active)), runningEditKeyboard(active.id))
    return
  }
  if (active?.state === 'paused') {
    return onNewAfterBreak(ctx, user, () => startTaskSession(ctx, user, taskId))
  }
  const session = active ?? await openCollecting(ctx, user.id)
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

const normalizeWorkTitle = (value: string) =>
  value
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()

function explicitlyReferencesTask(text: string, title: string): boolean {
  const haystack = normalizeWorkTitle(text)
  const needle = normalizeWorkTitle(title)
  if (!needle) return false
  return haystack === needle || ` ${haystack} `.includes(` ${needle} `)
}

function intentDisplayTitle(text: string, parsedTitle: string, task: { title: string } | null): string {
  if (task && (normalizeWorkTitle(text) === normalizeWorkTitle(task.title) || /(?:имел[аи]? в виду|то есть|не та работа|не это)/iu.test(text))) {
    return task.title
  }
  return parsedTitle.replace(/\s+/g, ' ').trim().slice(0, 80)
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
    const parsed = await parseIntent(ctx.llm, { text, tasks, profile: user.profileText }, llmMeter(ctx, user.id, 'intent', session.id))
    const pinned = session.taskId ? tasks.find((task) => task.id === session.taskId) ?? null : null
    const exact = tasks.find((task) => normalizeWorkTitle(task.title) === normalizeWorkTitle(text)) ?? null
    const proposed = parsed.result.taskId ? tasks.find((task) => task.id === parsed.result.taskId) ?? null : null
    const matched = pinned ?? exact ?? (proposed && explicitlyReferencesTask(text, proposed.title) ? proposed : null)
    taskId = matched?.id ?? null
    title = intentDisplayTitle(text, parsed.result.title, matched)
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
      const res = await tx.focusSession.updateMany({
        where: {
          id: session.id,
          userId: user.id,
          state: 'collecting_intent',
          intentText: session.intentText,
          taskId: session.taskId,
        },
        data: {
          intentText: title,
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
        await logEvent(tx, user.id, 'intent_parsed', { llm_used: llmUsed, task_id: taskId, is_new_task: taskId === null, scope }, { at: now, sessionId: session.id })
        if (failure) await logEvent(tx, user.id, 'llm_fallback', { stage: 'intent', reason: failure }, { at: now })
      }
    })
  } catch (error) {
    if (error instanceof StaleTransition) {
      await logEvent(ctx.db, user.id, 'route_stale', { stage: 'intent' }, { at: ctx.now(), sessionId: session.id })
      return reply(ctx, user, T.stale)
    }
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
      let taskId = session.taskId
      let isNewTask = false
      if (taskId === null && session.intentText) {
        const task = await tx.task.create({ data: { userId: user.id, title: session.intentText, createdAt: now } })
        taskId = task.id
        isNewTask = true
      }
      await transition(tx, { sessionId, userId: user.id }, 'collecting_intent', 'running', { startedAt: now, plannedEndAt, pingAt })
      if (isNewTask && taskId) {
        await tx.focusSession.update({ where: { id: sessionId }, data: { task: { connect: { id: taskId } } } })
      }
      if (pingAt) await enqueue(tx, { userId: user.id, kind: 'ping', key: `ping:${sessionId}:1`, sendAfter: pingAt, payload: { sessionId, n: 1 } })
      if (plannedEndAt) await enqueue(tx, { userId: user.id, kind: 'session_end', key: `session_end:${sessionId}`, sendAfter: plannedEndAt, payload: { sessionId } })
      if (taskId) {
        await tx.task.updateMany({
          where: { id: taskId, userId: user.id },
          data: { sessionsCount: { increment: 1 }, lastSessionAt: now },
        })
      }
      // Человек начал сам — ждущие напоминания на ближайшие часы уже не нужны.
      await cancelPending(tx, { userId: user.id, kind: 'rest_over' })
      await cancelPending(tx, { userId: user.id, kind: 'meeting', sendAfter: { lte: new Date(now.getTime() + 3 * 60 * MIN) } })
      await tx.user.update({ where: { id: user.id }, data: { declinesInRow: 0 } })
      await scheduleSummary(tx, user, now)
      await logEvent(
        tx,
        user.id,
        'session_started',
        {
          task_id: taskId,
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
  const parsed = await parseIntent(ctx.llm, { text, tasks, profile: user.profileText }, llmMeter(ctx, user.id, 'intent', session.id))
  const failure = parsed.failure && !parsed.failure.ok ? parsed.failure.reason : null
  const exact = tasks.find((task) => normalizeWorkTitle(task.title) === normalizeWorkTitle(text)) ?? null
  const proposed = parsed.result.taskId ? tasks.find((task) => task.id === parsed.result.taskId) ?? null : null
  const matched = exact ?? (proposed && explicitlyReferencesTask(text, proposed.title) ? proposed : null)
  const workTitle = intentDisplayTitle(text, parsed.result.title, matched)

  try {
    await ctx.db.$transaction(async (tx) => {
      let taskId = matched?.id ?? null
      let isNewTask = false
      if (taskId === null) {
        const task = await tx.task.create({ data: { userId: user.id, title: workTitle, createdAt: ctx.now() } })
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
        data: { intentText: workTitle, taskId, scope: parsed.result.scope },
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
        {
          llm_used: parsed.result.llmUsed,
          task_id: taskId,
          is_new_task: isNewTask,
          scope: parsed.result.scope,
          from_period_start: session.taskId === null,
        },
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
  await reply(ctx, user, T.runningWorkUpdated(workTitle), runningEditKeyboard(session.id))
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

  const lastResume = await ctx.db.event.findFirst({
    where: { subjectId: user.subjectId, sessionId, type: 'session_resumed', createdAt: { lte: now } },
    orderBy: { id: 'desc' },
    select: { createdAt: true },
  })
  const periodStartedAt = lastResume?.createdAt ?? session.startedAt
  const elapsedMs = Math.max(0, now.getTime() - periodStartedAt.getTime())
  const remainingMs = minutes * MIN - elapsedMs
  if (remainingMs <= 0) return reply(ctx, user, T.runningDurationTooShort(Math.max(1, Math.ceil(elapsedMs / MIN))))
  const plannedEndAt = new Date(now.getTime() + remainingMs)
  const rest = restFor(minutes)
  const technique: Technique = isTechnique(session.technique ?? '') ? (session.technique as Technique) : 'auto'
  let pingAt: Date | null = null
  if (user.pingsEnabled && session.pingAnsweredAt === null && technique !== 'pomodoro' && minutes >= 20) {
    const candidate = new Date(periodStartedAt.getTime() + (minutes / 2) * MIN)
    if (candidate > now) pingAt = candidate
  }

  try {
    await ctx.db.$transaction(async (tx) => {
      const endPrefix = `session_end:${session.id}`
      const endMessage = await tx.outboxMessage.findFirst({
        where: {
          userId: user.id,
          kind: 'session_end',
          idempotencyKey: { startsWith: endPrefix },
          status: { in: ['pending', 'paused', 'canceled'] },
        },
        orderBy: { createdAt: 'desc' },
      })
      await cancelPending(tx, { userId: user.id, idempotencyKey: { startsWith: endPrefix } })
      if (endMessage) {
        const updated = await tx.outboxMessage.updateMany({
          where: { id: endMessage.id, userId: user.id, status: { in: ['paused', 'canceled'] } },
          data: { status: 'pending', sendAfter: plannedEndAt, lockedUntil: null },
        })
        if (updated.count !== 1) throw new StaleTransition()
      } else {
        await enqueue(tx, {
          userId: user.id,
          kind: 'session_end',
          key: `${endPrefix}:${now.getTime()}:edit`,
          sendAfter: plannedEndAt,
          payload: { sessionId: session.id },
        })
      }

      const pingPrefix = `ping:${session.id}`
      const pingMessage = await tx.outboxMessage.findFirst({
        where: {
          userId: user.id,
          kind: 'ping',
          idempotencyKey: { startsWith: pingPrefix },
          status: { in: ['pending', 'paused', 'canceled'] },
        },
        orderBy: { createdAt: 'desc' },
      })
      await cancelPending(tx, { userId: user.id, idempotencyKey: { startsWith: pingPrefix } })
      if (pingAt && pingMessage) {
        const updated = await tx.outboxMessage.updateMany({
          where: { id: pingMessage.id, userId: user.id, status: { in: ['paused', 'canceled'] } },
          data: { status: 'pending', sendAfter: pingAt, lockedUntil: null },
        })
        if (updated.count !== 1) pingAt = null
      } else if (pingAt) {
        const series = `edit:${now.getTime()}`
        await enqueue(tx, {
          userId: user.id,
          kind: 'ping',
          key: `${pingPrefix}:${series}:1`,
          sendAfter: pingAt,
          payload: { sessionId: session.id, n: 1, series },
        })
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

export function deadlineKeyboard(sessionId: string): Keyboard {
  return [[
    { text: T.deadlineContinueButton, data: cb('end', sessionId, 'continue') },
    { text: T.deadlineBreakButton, data: cb('end', sessionId, 'break') },
  ]]
}

export async function onDeadlineChoice(
  ctx: Ctx,
  user: User,
  sessionId: string,
  choice: 'continue' | 'break',
): Promise<void> {
  const session = await ownedSession(ctx, user.id, sessionId)
  if (!session || session.state !== 'running') return reply(ctx, user, T.stale)
  const cleared = await ctx.db.user.updateMany({
    where: { id: user.id, pendingInput: `session_end:${sessionId}` },
    data: { pendingInput: 'none' },
  })
  if (cleared.count !== 1) return reply(ctx, user, T.stale)
  if (choice === 'break') return onBreak(ctx, { ...user, pendingInput: 'none' })
  await reply(ctx, user, T.deadlineContinue)
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
      await cancelPending(tx, { userId: user.id, idempotencyKey: { startsWith: `session_end:${sessionId}` } })
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
export async function onReportText(
  ctx: Ctx,
  user: User,
  text: string,
  options: { endDay?: boolean } = {},
): Promise<boolean> {
  const since = new Date(ctx.now().getTime() - REPORT_WINDOW_MS)
  const session = await ctx.db.focusSession.findFirst({
    where: {
      userId: user.id,
      state: 'finished',
      reportText: null,
      OR: [{ restChoice: null }, { restChoice: 'rest' }],
      finishedAt: { gte: since },
    },
    orderBy: { finishedAt: 'desc' },
  })
  if (!session) {
    await ctx.db.user.update({ where: { id: user.id }, data: { pendingInput: 'none' } })
    return false
  }
  await finalizeReport(ctx, user, session, text.trim().slice(0, REPORT_MAX), options)
  return true
}

export async function onSkipReport(ctx: Ctx, user: User, sessionId: string): Promise<void> {
  const session = await ownedSession(ctx, user.id, sessionId)
  if (!session || session.state !== 'finished' || (session.restChoice !== null && session.restChoice !== 'rest') || session.progress !== null) {
    return reply(ctx, user, T.stale)
  }
  await finalizeReport(ctx, user, session, null)
}

const STUCK_AFTER = 3

const normalizeTaskTitle = (value: string) =>
  value
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()

async function finalizeReport(
  ctx: Ctx,
  user: User,
  session: FocusSession,
  text: string | null,
  options: { endDay?: boolean } = {},
): Promise<void> {
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
  const reportTasks = text === null
    ? []
    : await ctx.db.task.findMany({
        where: { userId: user.id, status: { in: ['active', 'done'] } },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: 20,
        select: { id: true, title: true },
      })
  const labelledTasks = reportTasks.map((task, index) => ({ ...task, label: `t${index + 1}` }))
  const parsed = await parseReport(
    ctx.llm,
    {
      intent: session.intentText,
      outcome,
      report: text,
      tasks: labelledTasks.map(({ label, title }) => ({ label, title })),
    },
    llmMeter(ctx, user.id, 'report', session.id),
  )
  const failure = parsed.failure && !parsed.failure.ok ? parsed.failure.reason : null
  const continuationRelevant = session.restChoice === null && !options.endDay && parsed.result.continueNow && (await activeSession(ctx, user.id)) === null
  let stuckTask: string | null = null
  let allocatedMinutes: number | null = null
  let allocationInvalid = false

  const finishedAt = session.finishedAt ?? now
  const actualSeconds = Math.floor(activeElapsedMs(session, finishedAt) / 1000)
  const requestedSeconds = parsed.result.allocations
    .filter((allocation) => !allocation.remainder)
    .reduce((sum, allocation) => sum + (allocation.minutes ?? 0) * 60, 0)
  const remainderCount = parsed.result.allocations.filter((allocation) => allocation.remainder).length
  const hasUnknownLabel = parsed.result.allocations.some(
    (allocation) => allocation.taskLabel !== null && !labelledTasks.some((task) => task.label === allocation.taskLabel),
  )
  if (parsed.result.allocations.length > 0 && (requestedSeconds > actualSeconds || remainderCount > 1 || hasUnknownLabel)) {
    allocationInvalid = true
  }

  const reportApplied = await ctx.db.$transaction(async (tx) => {
    const res = await tx.focusSession.updateMany({
      where: { id: session.id, userId: user.id, progress: null, ...(options.endDay ? { restChoice: null } : {}) },
      data: {
        progress: parsed.result.progress,
        continueSuggested: continuationRelevant,
        ...(options.endDay ? { restChoice: 'day_end' } : {}),
      },
    })
    if (res.count !== 1) return false
    if (text === null) await tx.user.update({ where: { id: user.id }, data: { pendingInput: 'none' } })
    await logEvent(tx, user.id, 'report_parsed', { session_id: session.id, llm_used: parsed.result.llmUsed, progress: parsed.result.progress }, { at: now, sessionId: session.id })
    if (continuationRelevant) {
      await logEvent(tx, user.id, 'route_suggested', { kind: 'continue' }, { at: now, sessionId: session.id })
    }
    if (options.endDay) {
      await logEvent(tx, user.id, 'rest_chosen', { session_id: session.id, choice: 'day_end', rest_minutes: 0 }, { at: now, sessionId: session.id })
    }
    if (failure) await logEvent(tx, user.id, 'llm_fallback', { stage: 'report', reason: failure }, { at: now })

    if (!allocationInvalid && parsed.result.allocations.length > 0) {
      const byTask = new Map<string, number>()
      let unresolved = false
      for (const allocation of parsed.result.allocations) {
        let task = allocation.taskLabel
          ? labelledTasks.find((candidate) => candidate.label === allocation.taskLabel) ?? null
          : labelledTasks.find((candidate) => normalizeTaskTitle(candidate.title) === normalizeTaskTitle(allocation.title)) ?? null
        if (!task && allocation.taskLabel === null) {
          const created = await tx.task.create({ data: { userId: user.id, title: allocation.title, createdAt: now } })
          task = { id: created.id, title: created.title, label: '' }
        }
        if (!task) {
          unresolved = true
          break
        }
        const seconds = allocation.remainder ? actualSeconds - requestedSeconds : (allocation.minutes ?? 0) * 60
        byTask.set(task.id, (byTask.get(task.id) ?? 0) + seconds)
      }
      if (unresolved || byTask.size === 0) {
        allocationInvalid = true
      } else {
        await tx.taskTimeAllocation.deleteMany({ where: { userId: user.id, sessionId: session.id } })
        await tx.taskTimeAllocation.createMany({
          data: [...byTask.entries()].map(([taskId, seconds]) => ({
            userId: user.id,
            sessionId: session.id,
            taskId,
            seconds,
            source: 'report',
            createdAt: now,
            updatedAt: now,
          })),
        })
        const allocatedSeconds = [...byTask.values()].reduce((sum, seconds) => sum + seconds, 0)
        allocatedMinutes = Math.floor(allocatedSeconds / 60)
        await logEvent(
          tx,
          user.id,
          'task_time_allocated',
          {
            session_id: session.id,
            task_count: byTask.size,
            allocated_seconds: allocatedSeconds,
            unassigned_seconds: Math.max(0, actualSeconds - allocatedSeconds),
            source: 'report',
          },
          { at: now, sessionId: session.id },
        )
      }
    }

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
    return true
  })

  if (!reportApplied) {
    await logEvent(ctx.db, user.id, 'route_stale', { stage: 'report' }, { at: ctx.now(), sessionId: session.id })
    await reply(ctx, user, T.stale)
    return
  }

  const activeAfterReport = await activeSession(ctx, user.id)
  if (activeAfterReport) {
    if (continuationRelevant) {
      await ctx.db.focusSession.updateMany({
        where: { id: session.id, userId: user.id, continueSuggested: true, restChoice: null },
        data: { continueSuggested: false },
      })
    }
    await logEvent(ctx.db, user.id, 'route_stale', { stage: 'report' }, { at: ctx.now(), sessionId: session.id })
    return
  }

  if (stuckTask) await reply(ctx, user, T.stuck(stuckTask))
  if (allocationInvalid) await reply(ctx, user, T.timeAllocationInvalid)
  else if (allocatedMinutes !== null) await reply(ctx, user, T.timeAllocated(allocatedMinutes))
  if (!options.endDay && session.restChoice === null) await askRest(ctx, user, session, { continueSuggested: continuationRelevant })
}

// После нескольких сессий бот сам замечает рисунок и предлагает технику одной
// репликой. Решает код по истории, а не модель; предлагает один раз.
export const SUGGEST_AFTER_COUNTED = 3

async function maybeSuggestTechnique(ctx: Ctx, user: User): Promise<string | null> {
  const fresh = await ctx.db.user.findUniqueOrThrow({ where: { id: user.id } })
  if (fresh.technique !== 'auto' || fresh.techniqueSuggestedAt || fresh.countedSessions < SUGGEST_AFTER_COUNTED) return null
  const history = await ctx.db.focusSession.findMany({
    where: { userId: user.id, state: { in: ['finished', 'abandoned'] } },
    orderBy: { createdAt: 'desc' },
    take: 3,
    select: { state: true, counted: true, minutesAdjusted: true, restChoice: true },
  })
  const extends3 = history.length === 3 && history.every((s) => s.counted && (s.minutesAdjusted === 'up' || s.restChoice === 'continue'))
  const drops = history.slice(0, 3).filter((s) => s.state === 'abandoned' || s.minutesAdjusted === 'down').length >= 2
  const pick = extends3 ? 'long' : drops ? 'pomodoro' : null
  if (!pick) return null
  const marked = await ctx.db.user.updateMany({ where: { id: user.id, techniqueSuggestedAt: null }, data: { techniqueSuggestedAt: ctx.now() } })
  if (marked.count !== 1) return null
  return pick === 'long' ? T.suggestLongInline : T.suggestShortInline
}

// После отчёта отдых предлагается, а не назначается. Если ответа нет, через
// время отдыха всё равно придёт «отдохнул?» — бот не замолкает.
async function askRest(
  ctx: Ctx,
  user: User,
  session: FocusSession,
  options: { continueSuggested?: boolean } = {},
): Promise<void> {
  const now = ctx.now()
  const rest = session.plannedRestMinutes ?? restFor(session.plannedMinutes)
  await enqueue(ctx.db, {
    userId: user.id,
    kind: 'rest_over',
    key: `rest_over:${session.id}`,
    sendAfter: new Date(now.getTime() + rest * MIN),
    payload: { sessionId: session.id },
  })
  if (options.continueSuggested && session.taskId) {
    const task = await ctx.db.task.findFirst({ where: { id: session.taskId, userId: user.id, status: 'active' }, select: { title: true } })
    if (task) {
      const label = Array.from(task.title).length > 32 ? `${Array.from(task.title).slice(0, 31).join('')}…` : task.title
      await reply(ctx, user, T.continuePrompt(task.title, session.plannedMinutes), [
        [{ text: T.continueSame(label, session.plannedMinutes), data: cb('again', session.id, 'same') }],
        [
          { text: T.continueClarify, data: cb('again', session.id, 'step') },
          { text: T.continueChange, data: cb('again', session.id, 'change') },
        ],
        [{ text: T.restOk(rest), data: cb('rest', session.id, 'rest') }],
        [{ text: T.restLater, data: cb('rest', session.id, 'later') }],
        [{ text: T.dayEnd, data: cb('rest', session.id, 'day_end') }],
      ])
      return
    }
  }
  await reply(ctx, user, T.askRest(rest), [
    [{ text: T.restOk(rest), data: cb('rest', session.id, 'rest') }],
    [{ text: T.restContinue, data: cb('rest', session.id, 'continue') }],
    [{ text: T.restLater, data: cb('rest', session.id, 'later') }],
    [{ text: T.dayEnd, data: cb('rest', session.id, 'day_end') }],
  ])
}

export type RestChoice = 'rest' | 'continue' | 'later' | 'day_end'

export type ContinueChoice = 'same' | 'step' | 'change'

export async function onContinueChoice(
  ctx: Ctx,
  user: User,
  sessionId: string,
  choice: ContinueChoice,
  next: { change: () => Promise<void> },
): Promise<void> {
  const session = await ownedSession(ctx, user.id, sessionId)
  if (!session || session.state !== 'finished' || session.restChoice !== null || !session.continueSuggested) {
    return reply(ctx, user, T.stale)
  }
  const task = session.taskId
    ? await ctx.db.task.findFirst({ where: { id: session.taskId, userId: user.id, status: 'active' }, select: { id: true, title: true } })
    : null
  if ((choice === 'same' || choice === 'step') && !task) return reply(ctx, user, T.stale)
  if (await activeSession(ctx, user.id)) return reply(ctx, user, T.stale)

  const now = ctx.now()
  let collectingId: string | null = null
  try {
    const claimed = await ctx.db.$transaction(async (tx) => {
      const res = await tx.focusSession.updateMany({
        where: { id: sessionId, userId: user.id, state: 'finished', restChoice: null, continueSuggested: true },
        data: { restChoice: 'continue' },
      })
      if (res.count !== 1) return false
      if (choice === 'same' || choice === 'step') {
        const created = await tx.focusSession.create({
          data: {
            userId: user.id,
            state: 'collecting_intent',
            taskId: task!.id,
            intentText: choice === 'same' ? task!.title : null,
            scope: 'step',
            plannedMinutes: session.plannedMinutes,
            minutesSource: session.minutesSource,
            plannedRestMinutes: session.plannedRestMinutes,
            technique: session.technique,
            createdAt: now,
          },
        })
        collectingId = created.id
      }
      await tx.user.update({ where: { id: user.id }, data: { pendingInput: 'none' } })
      await cancelPending(tx, { userId: user.id, idempotencyKey: `rest_over:${sessionId}` })
      await logEvent(tx, user.id, 'rest_chosen', { session_id: sessionId, choice: 'continue', rest_minutes: 0 }, { at: now, sessionId })
      await logEvent(
        tx,
        user.id,
        'route_confirmed',
        { kind: 'continue', choice: choice === 'same' ? 'same_task' : choice === 'step' ? 'clarify_step' : 'change_task' },
        { at: now, sessionId },
      )
      return true
    })
    if (!claimed) return reply(ctx, user, T.stale)
  } catch (error) {
    if (isUniqueViolation(error)) return reply(ctx, user, T.stale)
    throw error
  }

  if (choice === 'same') return startRunning(ctx, user, collectingId!)
  if (choice === 'change') return next.change()
  await reply(ctx, user, T.askContinue)
}

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
  if (await activeSession(ctx, user.id)) return reply(ctx, user, T.stale)
  const rest = session.plannedRestMinutes ?? restFor(session.plannedMinutes)

  const ok = await ctx.db.$transaction(async (tx) => {
    const res = await tx.focusSession.updateMany({
      where: { id: sessionId, userId: user.id, restChoice: null },
      data: { restChoice: choice },
    })
    if (res.count !== 1) return false
    await tx.user.update({ where: { id: user.id }, data: { pendingInput: 'none' } })
    await logEvent(tx, user.id, 'rest_chosen', { session_id: sessionId, choice, rest_minutes: choice === 'rest' ? rest : 0 }, { at: now, sessionId })
    if (session.continueSuggested) {
      if (choice === 'continue') {
        await logEvent(tx, user.id, 'route_confirmed', { kind: 'continue', choice: 'clarify_step' }, { at: now, sessionId })
      } else {
        await logEvent(tx, user.id, 'route_rejected', { kind: 'continue', choice }, { at: now, sessionId })
      }
    }
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
  const techniqueHint = choice === 'continue' || choice === 'rest' ? await maybeSuggestTechnique(ctx, user) : null

  if (choice === 'rest') {
    const message = T.restStarted(hhmm(new Date(now.getTime() + rest * MIN), user.timezone))
    return reply(ctx, user, techniqueHint ? `${techniqueHint}\n${message}` : message)
  }
  if (choice === 'continue') return askIntent(ctx, user, { continue: true, ...(techniqueHint ? { prefix: techniqueHint } : {}) })
  if (choice === 'later') return next.later()
  return next.dayEnd()
}

// «Перерыв» завершает текущий рабочий период, но не логическую сессию. При
// возврате начинается новый полный период той же настроенной длительности.
export async function onBreak(ctx: Ctx, user: User): Promise<void> {
  const now = ctx.now()
  const session = await activeSession(ctx, user.id)
  if (!session) return reply(ctx, user, T.restingIdle)
  if (session.state === 'collecting_intent') {
    await ctx.db.$transaction(async (tx) => {
      await transition(tx, { sessionId: session.id, userId: user.id }, 'collecting_intent', 'cancelled', { finishedAt: now })
      await tx.user.update({ where: { id: user.id }, data: { pendingInput: 'none' } })
      await logEvent(tx, user.id, 'session_cancelled', {}, { at: now, sessionId: session.id })
    })
    return reply(ctx, user, T.restingIdle)
  }
  if (session.state === 'paused') return reply(ctx, user, T.breakChoice)
  try {
    await ctx.db.$transaction(async (tx) => {
      await transition(tx, { sessionId: session.id, userId: user.id }, 'running', 'paused', { pausedAt: now })
      await tx.outboxMessage.updateMany({
        where: {
          userId: user.id,
          status: { in: ['pending', 'paused'] },
          OR: [
            { idempotencyKey: { startsWith: `ping:${session.id}` } },
            { idempotencyKey: { startsWith: `session_end:${session.id}` } },
          ],
        },
        data: { status: 'canceled' },
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
  const plannedEndAt = session.plannedMinutes === null ? null : new Date(now.getTime() + session.plannedMinutes * MIN)
  const pingAt = periodPingAt(user, session, now)
  const period = now.getTime()

  try {
    await ctx.db.$transaction(async (tx) => {
      await transition(tx, { sessionId: session.id, userId: user.id }, 'paused', 'running', {
        pausedAt: null,
        pausedSeconds: { increment: Math.floor(pauseMs / 1000) },
        plannedEndAt,
        pingAt,
        pingAnsweredAt: null,
        pingsMissed: 0,
      })
      await tx.outboxMessage.updateMany({
        where: {
          userId: user.id,
          status: { in: ['pending', 'paused'] },
          OR: [
            { idempotencyKey: { startsWith: `ping:${session.id}` } },
            { idempotencyKey: { startsWith: `session_end:${session.id}` } },
          ],
        },
        data: { status: 'canceled' },
      })
      if (pingAt) {
        await enqueue(tx, {
          userId: user.id,
          kind: 'ping',
          key: `ping:${session.id}:period:${period}:1`,
          sendAfter: pingAt,
          payload: { sessionId: session.id, n: 1, series: `period:${period}` },
        })
      }
      if (plannedEndAt) {
        await enqueue(tx, {
          userId: user.id,
          kind: 'session_end',
          key: `session_end:${session.id}:${period}`,
          sendAfter: plannedEndAt,
          payload: { sessionId: session.id },
        })
      }
      await logEvent(tx, user.id, 'session_resumed', { session_id: session.id, paused_minutes: Math.floor(pauseMs / MIN) }, { at: now, sessionId: session.id })
    })
  } catch (error) {
    if (error instanceof StaleTransition) return reply(ctx, user, T.stale)
    throw error
  }
  await reply(ctx, user, T.breakResumed(session.plannedMinutes, plannedEndAt ? hhmm(plannedEndAt, user.timezone) : null))
}

export async function onNewAfterBreak(ctx: Ctx, user: User, afterClose?: () => Promise<void>): Promise<void> {
  const now = ctx.now()
  const session = await activeSession(ctx, user.id)
  if (!session) {
    if (afterClose) await afterClose()
    else await onStartButton(ctx, user)
    return
  }
  const pauseMs = session.state === 'paused' && session.pausedAt ? Math.max(0, now.getTime() - session.pausedAt.getTime()) : 0
  const elapsed = Math.floor(activeElapsedMs(session, now) / MIN)

  try {
    await ctx.db.$transaction(async (tx) => {
      if (session.state === 'collecting_intent') {
        await transition(tx, { sessionId: session.id, userId: user.id }, 'collecting_intent', 'cancelled', { finishedAt: now })
        await logEvent(tx, user.id, 'session_cancelled', {}, { at: now, sessionId: session.id })
      } else {
        const from = session.state === 'paused' ? 'paused' : 'running'
        await transition(tx, { sessionId: session.id, userId: user.id }, from, 'abandoned', {
          pausedAt: null,
          pausedSeconds: { increment: Math.floor(pauseMs / 1000) },
          finishedAt: now,
          abandonReason: 'new_session',
        })
      }
      await tx.outboxMessage.updateMany({
        where: {
          userId: user.id,
          status: { in: ['pending', 'paused'] },
          OR: [
            { idempotencyKey: { startsWith: `ping:${session.id}` } },
            { idempotencyKey: { startsWith: `session_end:${session.id}` } },
          ],
        },
        data: { status: 'canceled' },
      })
      await tx.user.update({ where: { id: user.id }, data: { pendingInput: 'none' } })
      if (session.state !== 'collecting_intent') {
        await logEvent(tx, user.id, 'session_stopped', { session_id: session.id, elapsed_minutes: elapsed }, { at: now, sessionId: session.id })
      }
    })
  } catch (error) {
    if (error instanceof StaleTransition) return reply(ctx, user, T.stale)
    throw error
  }
  if (afterClose) await afterClose()
  else await onStartButton(ctx, user)
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
      await cancelPending(tx, { userId: user.id, idempotencyKey: { startsWith: `session_end:${session.id}` } })
      await tx.outboxMessage.updateMany({
        where: {
          userId: user.id,
          status: 'paused',
          OR: [
            { idempotencyKey: { startsWith: `ping:${session.id}` } },
            { idempotencyKey: { startsWith: `session_end:${session.id}` } },
          ],
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
