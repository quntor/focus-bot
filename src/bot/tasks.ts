import type { User } from '@prisma/client'
import { logEvent } from '../analytics/log.js'
import { dayKey } from '../lib/day.js'
import { parseIntent } from '../llm/intent.js'
import { parseTaskMessage } from '../llm/tasks.js'
import { cancelPending } from '../outbox/queue.js'
import { creditCountedSession } from '../retention/credit.js'
import { isCounted } from '../retention/rules.js'
import { StaleTransition, transition } from '../session/fsm.js'
import { TelegramError, type Keyboard } from '../tg/client.js'
import { cb } from './callbacks.js'
import { reply, type Ctx } from './context.js'
import { activeElapsedMinutes, activeSession, onStartButton, startTaskSession } from './session-flow.js'
import { T } from './texts.js'

export type TaskInputSource = 'text' | 'voice'
export type TaskMessageOutcome = 'handled' | 'session_intent' | 'close_day'

export const MAX_VOICE_SECONDS = 180
export const MAX_VOICE_BYTES = 5 * 1024 * 1024
export const MAX_VOICE_PER_HOUR = 5

// Один production-процесс: локальный cost guard не хранит tg_id на диске и
// режет дешёвую атаку повторными длинными voice раньше Telegram download/STT.
const voiceUsage = new Map<bigint, number[]>()

function allowVoice(tgId: bigint, now: Date): boolean {
  const since = now.getTime() - 60 * 60_000
  const recent = (voiceUsage.get(tgId) ?? []).filter((at) => at >= since)
  if (recent.length >= MAX_VOICE_PER_HOUR) {
    voiceUsage.set(tgId, recent)
    return false
  }
  recent.push(now.getTime())
  voiceUsage.set(tgId, recent)
  return true
}

const normalize = (value: string) =>
  value
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()

const TASKS_PER_PAGE = 6

type TaskPage = {
  tasks: { id: string; title: string }[]
  page: number
  pages: number
}

function taskLabel(title: string): string {
  const chars = Array.from(title.replace(/\s+/g, ' ').trim())
  return chars.length <= 60 ? chars.join('') : `${chars.slice(0, 59).join('')}…`
}

function taskKeyboard(
  tasks: { id: string; title: string }[],
  page: number,
  pages: number,
  restore?: { id: string },
  mode: 'actions' | 'start' = 'actions',
): Keyboard {
  const keyboard: Keyboard = tasks.map((task) => [
    { text: taskLabel(task.title), data: cb('task', task.id, mode === 'start' ? 'start' : `view${page}`) },
  ])
  const pageMode = mode === 'start' ? 's' : 'p'
  if (page > 0) keyboard.push([{ text: '← Назад', data: cb('tasks', null, `${pageMode}${page - 1}`) }])
  if (page + 1 < pages) keyboard.push([{ text: 'Дальше →', data: cb('tasks', null, `${pageMode}${page + 1}`) }])
  if (restore) keyboard.push([{ text: T.taskRestoreButton, data: cb('task', restore.id, 'restore') }])
  return keyboard
}

async function activeTaskPage(ctx: Ctx, user: User, page: number): Promise<TaskPage | null> {
  const count = await ctx.db.task.count({ where: { userId: user.id, status: 'active' } })
  if (count === 0) return null
  const pages = Math.ceil(count / TASKS_PER_PAGE)
  const safePage = Math.max(0, Math.min(page, pages - 1))
  const tasks = await ctx.db.task.findMany({
    where: { userId: user.id, status: 'active' },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    skip: safePage * TASKS_PER_PAGE,
    take: TASKS_PER_PAGE,
    select: { id: true, title: true },
  })
  return { tasks, page: safePage, pages }
}

export async function buildTaskStartPrompt(
  ctx: Ctx,
  user: User,
  prefix: string,
  page = 0,
): Promise<{ text: string; keyboard: Keyboard } | null> {
  const list = await activeTaskPage(ctx, user, page)
  if (!list) return null
  return {
    text: T.tasksStartList(list.tasks.map((task) => task.title), list.page, list.pages, prefix),
    keyboard: taskKeyboard(list.tasks, list.page, list.pages, undefined, 'start'),
  }
}

async function showTaskStartPrompt(ctx: Ctx, user: User, page: number): Promise<void> {
  const prompt = await buildTaskStartPrompt(ctx, user, T.meetingPlain, page)
  if (!prompt) return reply(ctx, user, T.tasksEmpty)
  await reply(ctx, user, prompt.text, prompt.keyboard)
}

export async function showTasks(ctx: Ctx, user: User, page = 0, notice?: string, restore?: { id: string }): Promise<void> {
  const list = await activeTaskPage(ctx, user, page)
  if (!list) {
    await reply(ctx, user, notice ? `${notice}\n${T.tasksEmpty}` : T.tasksEmpty, restore ? [[{ text: T.taskRestoreButton, data: cb('task', restore.id, 'restore') }]] : undefined)
    return
  }
  await reply(
    ctx,
    user,
    T.tasksList(list.tasks.map((task) => task.title), list.page, list.pages, notice),
    taskKeyboard(list.tasks, list.page, list.pages, restore),
  )
}

export async function onSessionStart(ctx: Ctx, user: User): Promise<void> {
  await onStartButton(ctx, user)
  const running = await activeSession(ctx, user.id)
  if (running?.state !== 'running') return
  const count = await ctx.db.task.count({ where: { userId: user.id, status: 'active' } })
  if (count > 0) await showTasks(ctx, user, 0, T.tasksChoose)
}

export async function onTasksPage(ctx: Ctx, user: User, arg: string): Promise<void> {
  const match = /^([ps])(\d{1,4})$/.exec(arg)
  if (!match) return reply(ctx, user, T.stale)
  const page = Number(match[2])
  if (match[1] === 's') return showTaskStartPrompt(ctx, user, page)
  await showTasks(ctx, user, page)
}

export async function onTaskOpened(ctx: Ctx, user: User, taskId: string, page: number): Promise<void> {
  const task = await ctx.db.task.findFirst({
    where: { id: taskId, userId: user.id, status: 'active' },
    select: { id: true, title: true },
  })
  if (!task) return reply(ctx, user, T.stale)
  await reply(ctx, user, T.taskActions(task.title), [
    [
      { text: T.taskStartButton, data: cb('task', task.id, 'start') },
      { text: T.taskDropButton, data: cb('task', task.id, 'drop') },
    ],
    [{ text: T.tasksBackButton, data: cb('tasks', null, `p${page}`) }],
  ])
}

export async function onTaskSelected(ctx: Ctx, user: User, taskId: string): Promise<void> {
  await startTaskSession(ctx, user, taskId)
}

export async function onTaskDropped(ctx: Ctx, user: User, taskId: string): Promise<void> {
  let title: string | null = null
  let isCurrent = false
  await ctx.db.$transaction(async (tx) => {
    const locked = await tx.task.updateMany({
      where: { id: taskId, userId: user.id, status: 'active' },
      data: { status: 'active' },
    })
    if (locked.count !== 1) return
    const task = await tx.task.findFirst({ where: { id: taskId, userId: user.id, status: 'active' }, select: { title: true } })
    if (!task) return
    title = task.title
    const current = await tx.focusSession.findFirst({
      where: { userId: user.id, taskId, state: { in: ['collecting_intent', 'running', 'paused'] } },
      select: { id: true },
    })
    if (current) {
      isCurrent = true
      return
    }
    await tx.task.update({ where: { id: taskId }, data: { status: 'dropped' } })
  })
  if (!title) return reply(ctx, user, T.stale)
  if (isCurrent) return reply(ctx, user, T.taskDropActive)
  await showTasks(ctx, user, 0, T.taskDropped(title), { id: taskId })
}

export async function onTaskRestored(ctx: Ctx, user: User, taskId: string): Promise<void> {
  const task = await ctx.db.task.findFirst({ where: { id: taskId, userId: user.id, status: 'dropped' } })
  if (!task) return reply(ctx, user, T.stale)
  const restored = await ctx.db.task.updateMany({
    where: { id: task.id, userId: user.id, status: 'dropped' },
    data: { status: 'active' },
  })
  if (restored.count !== 1) return reply(ctx, user, T.stale)
  await showTasks(ctx, user, 0, T.taskRestored(task.title))
}

async function captureTasks(ctx: Ctx, user: User, titles: string[], source: TaskInputSource) {
  return ctx.db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${user.id}))`
    const active = await tx.task.findMany({ where: { userId: user.id, status: 'active' } })
    const byTitle = new Map(active.map((task) => [normalize(task.title), task]))
    const selected: { id: string; title: string }[] = []
    for (const raw of titles) {
      const title = raw.replace(/\s+/g, ' ').trim().slice(0, 80)
      const key = normalize(title)
      if (!key) continue
      let task = byTitle.get(key)
      if (!task) {
        task = await tx.task.create({ data: { userId: user.id, title, createdAt: ctx.now() } })
        byTitle.set(key, task)
      }
      selected.push({ id: task.id, title: task.title })
    }
    const unique = [...new Map(selected.map((task) => [task.id, task])).values()]
    if (unique.length) {
      await logEvent(tx, user.id, 'tasks_captured', { count: unique.length, source }, { at: ctx.now() })
    }
    return unique
  })
}

async function resolveOrCreateTask(
  ctx: Ctx,
  user: User,
  title: string,
  activeTasks: { id: string; title: string }[],
  source: TaskInputSource,
): Promise<{ id: string; title: string }> {
  const parsed = activeTasks.length
    ? await parseIntent(ctx.llm, { text: title, tasks: activeTasks, profile: user.profileText })
    : { result: { taskId: null, title, scope: 'step' as const, llmUsed: false }, failure: null }
  if (parsed.failure && !parsed.failure.ok) {
    await logEvent(ctx.db, user.id, 'llm_fallback', { stage: 'intent', reason: parsed.failure.reason }, { at: ctx.now() })
  }

  const candidate = parsed.result.title.replace(/\s+/g, ' ').trim().slice(0, 80) || title.replace(/\s+/g, ' ').trim().slice(0, 80)
  return ctx.db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${user.id}))`
    if (parsed.result.taskId) {
      const matched = await tx.task.findFirst({
        where: { id: parsed.result.taskId, userId: user.id, status: 'active' },
        select: { id: true, title: true },
      })
      if (matched) return matched
    }

    const tasks = await tx.task.findMany({ where: { userId: user.id, status: 'active' }, select: { id: true, title: true } })
    const existing = tasks.find((task) => normalize(task.title) === normalize(candidate) || normalize(task.title) === normalize(title))
    if (existing) return existing
    const created = await tx.task.create({ data: { userId: user.id, title: candidate, createdAt: ctx.now() }, select: { id: true, title: true } })
    await logEvent(tx, user.id, 'tasks_captured', { count: 1, source }, { at: ctx.now() })
    return created
  })
}

async function resolveExistingTask(
  ctx: Ctx,
  user: User,
  title: string | null,
  activeTasks: { id: string; title: string }[],
  currentTaskId: string | null,
): Promise<{ id: string; title: string } | null> {
  if (title === null) {
    if (!currentTaskId) return null
    return ctx.db.task.findFirst({
      where: { id: currentTaskId, userId: user.id, status: 'active' },
      select: { id: true, title: true },
    })
  }
  if (!activeTasks.length) return null

  const parsed = await parseIntent(ctx.llm, { text: title, tasks: activeTasks, profile: user.profileText })
  if (parsed.failure && !parsed.failure.ok) {
    await logEvent(ctx.db, user.id, 'llm_fallback', { stage: 'intent', reason: parsed.failure.reason }, { at: ctx.now() })
  }
  if (parsed.result.taskId) {
    const matched = await ctx.db.task.findFirst({
      where: { id: parsed.result.taskId, userId: user.id, status: 'active' },
      select: { id: true, title: true },
    })
    if (matched) return matched
  }

  const candidates = [title, parsed.result.title].map(normalize)
  return activeTasks.find((task) => candidates.includes(normalize(task.title))) ?? null
}

async function completeTask(
  ctx: Ctx,
  user: User,
  task: { id: string; title: string },
  source: TaskInputSource,
): Promise<boolean> {
  const now = ctx.now()
  let doneTitle = task.title
  try {
    await ctx.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${user.id}))`
      const completed = await tx.task.findFirst({
        where: { id: task.id, userId: user.id, status: 'active' },
        select: { id: true, title: true },
      })
      if (!completed) throw new StaleTransition()
      doneTitle = completed.title

      const current = await tx.focusSession.findFirst({
        where: { userId: user.id, state: { in: ['collecting_intent', 'running', 'paused'] } },
      })
      if (current?.taskId === completed.id && current.state === 'collecting_intent') {
        await transition(tx, { sessionId: current.id, userId: user.id }, 'collecting_intent', 'cancelled', { finishedAt: now })
        await logEvent(tx, user.id, 'session_cancelled', {}, { at: now, sessionId: current.id })
      } else if (current?.taskId === completed.id && (current.state === 'running' || current.state === 'paused')) {
        const openPauseSeconds =
          current.state === 'paused' && current.pausedAt
            ? Math.floor(Math.max(0, now.getTime() - current.pausedAt.getTime()) / 1000)
            : 0
        const elapsed = activeElapsedMinutes(current, now)
        const counted = isCounted('finished', elapsed)
        const early = current.plannedEndAt !== null && now < current.plannedEndAt
        await transition(tx, { sessionId: current.id, userId: user.id }, current.state, 'finished', {
          outcome: 'done',
          pausedAt: null,
          pausedSeconds: current.pausedSeconds + openPauseSeconds,
          finishedAt: now,
          counted,
          progress: 'moved',
        })
        await cancelPending(tx, { userId: user.id, idempotencyKey: { startsWith: `ping:${current.id}` } })
        await cancelPending(tx, { userId: user.id, idempotencyKey: `session_end:${current.id}` })
        await logEvent(
          tx,
          user.id,
          'session_completed',
          { session_id: current.id, outcome: 'done', elapsed_minutes: elapsed, early, counted },
          { at: now, sessionId: current.id },
        )
        if (counted) {
          await creditCountedSession(tx, { userId: user.id, sessionId: current.id, dayKey: dayKey(now, user.timezone), at: now })
        }
      }

      const marked = await tx.task.updateMany({
        where: { id: completed.id, userId: user.id, status: 'active' },
        data: { status: 'done', lastProgressAt: now, sessionsSinceProgress: 0 },
      })
      if (marked.count !== 1) throw new StaleTransition()
      await tx.user.update({ where: { id: user.id }, data: { pendingInput: 'none' } })
      await logEvent(tx, user.id, 'task_completed', { task_id: completed.id, source }, { at: now, sessionId: current?.id })
    })
  } catch (error) {
    if (error instanceof StaleTransition) {
      await reply(ctx, user, T.stale)
      return false
    }
    throw error
  }
  await reply(ctx, user, T.taskCompleted(doneTitle))
  return true
}

async function completeAndStart(
  ctx: Ctx,
  user: User,
  input: { completeTaskId: string; start: { taskId: string | null; title: string } },
  source: TaskInputSource,
): Promise<void> {
  const current = await activeSession(ctx, user.id)
  if (current?.state === 'paused') return reply(ctx, user, T.taskSwitchPaused)
  if (current?.state === 'running' && current.taskId !== input.completeTaskId) {
    return reply(ctx, user, T.taskSwitchMismatch)
  }

  const now = ctx.now()
  let next: { id: string; title: string } | null = null
  let doneTitle = ''
  try {
    await ctx.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${user.id}))`
      const completed = await tx.task.findFirst({ where: { id: input.completeTaskId, userId: user.id, status: 'active' } })
      if (!completed) throw new StaleTransition()
      doneTitle = completed.title

      if (input.start.taskId) {
        next = await tx.task.findFirst({ where: { id: input.start.taskId, userId: user.id, status: 'active' } })
        if (!next) throw new StaleTransition()
      } else {
        const duplicate = await tx.task.findMany({ where: { userId: user.id, status: 'active' } })
        next = duplicate.find((task) => normalize(task.title) === normalize(input.start.title)) ?? null
        if (!next) next = await tx.task.create({ data: { userId: user.id, title: input.start.title, createdAt: now } })
      }
      if (!next || next.id === completed.id) throw new StaleTransition()

      if (current?.state === 'running') {
        const elapsed = activeElapsedMinutes(current, now)
        const counted = isCounted('finished', elapsed)
        const early = current.plannedEndAt !== null && now < current.plannedEndAt
        await transition(tx, { sessionId: current.id, userId: user.id }, 'running', 'finished', {
          outcome: 'done',
          finishedAt: now,
          counted,
          progress: 'moved',
          restChoice: 'continue',
        })
        await cancelPending(tx, { userId: user.id, idempotencyKey: { startsWith: `ping:${current.id}` } })
        await cancelPending(tx, { userId: user.id, idempotencyKey: `session_end:${current.id}` })
        await logEvent(
          tx,
          user.id,
          'session_completed',
          { session_id: current.id, outcome: 'done', elapsed_minutes: elapsed, early, counted },
          { at: now, sessionId: current.id },
        )
        if (counted) await creditCountedSession(tx, { userId: user.id, sessionId: current.id, dayKey: dayKey(now, user.timezone), at: now })
      } else if (current?.state === 'collecting_intent') {
        await transition(tx, { sessionId: current.id, userId: user.id }, 'collecting_intent', 'cancelled', { finishedAt: now })
        await logEvent(tx, user.id, 'session_cancelled', {}, { at: now, sessionId: current.id })
      }

      const marked = await tx.task.updateMany({
        where: { id: completed.id, userId: user.id, status: 'active' },
        data: { status: 'done', lastProgressAt: now, sessionsSinceProgress: 0 },
      })
      if (marked.count !== 1) throw new StaleTransition()
      await tx.user.update({ where: { id: user.id }, data: { pendingInput: 'none' } })
      await logEvent(
        tx,
        user.id,
        'task_switched',
        { from_task_id: completed.id, to_task_id: next.id, source },
        { at: now, sessionId: current?.id },
      )
    })
  } catch (error) {
    if (error instanceof StaleTransition) return reply(ctx, user, T.stale)
    throw error
  }

  const selectedNext = next as { id: string; title: string } | null
  if (!selectedNext) return reply(ctx, user, T.stale)
  await reply(ctx, user, T.taskSwitched(doneTitle, selectedNext.title))
  await startTaskSession(ctx, user, selectedNext.id)
}

// Модель только классифицирует свободную речь. Вызывающий выполняет
// обычное намерение или закрытие дня; операции с задачами делаются здесь.
export async function onTaskMessage(ctx: Ctx, user: User, text: string, source: TaskInputSource): Promise<TaskMessageOutcome> {
  const current = await activeSession(ctx, user.id)
  const storedTasks = await ctx.db.task.findMany({
    where: { userId: user.id, status: 'active' },
    orderBy: { createdAt: 'desc' },
    take: 20,
    select: { id: true, title: true },
  })
  // Текущая задача всегда t1: тогда фразы «эту сделал» устойчивы к NULL-order
  // базы и не зависят от того, когда создавались остальные дела.
  const activeTasks = current?.taskId
    ? [...storedTasks.filter((task) => task.id === current.taskId), ...storedTasks.filter((task) => task.id !== current.taskId)]
    : storedTasks
  const parsed = await parseTaskMessage(ctx.llm, { text, tasks: activeTasks, currentTaskId: current?.taskId ?? null })
  if (!parsed.result) {
    const reason = parsed.failure && !parsed.failure.ok ? parsed.failure.reason : 'invalid'
    await logEvent(ctx.db, user.id, 'llm_fallback', { stage: 'tasks', reason }, { at: ctx.now(), sessionId: current?.id })
    // В сборке без LLM сохраняем базовый текстовый старт сессии. Ошибка
    // включённой модели не даёт частичных операций: просим повторить.
    if (reason === 'disabled') return 'session_intent'
    await reply(ctx, user, T.tasksParseFailed)
    return 'handled'
  }

  const count = parsed.result.kind === 'capture'
    ? parsed.result.titles.length
    : ['start_task', 'complete_task', 'complete_and_start', 'complete_and_close_day'].includes(parsed.result.kind)
      ? 1
      : 0
  await logEvent(ctx.db, user.id, 'tasks_parsed', { kind: parsed.result.kind, count }, { at: ctx.now(), sessionId: current?.id })
  if (parsed.result.kind === 'session_intent') return 'session_intent'
  if (parsed.result.kind === 'close_day') return 'close_day'
  if (parsed.result.kind === 'capture') {
    const tasks = await captureTasks(ctx, user, parsed.result.titles, source)
    if (!tasks.length) {
      await reply(ctx, user, T.tasksParseFailed)
      return 'handled'
    }
    await showTasks(ctx, user, 0, T.tasksCaptured(tasks.map((task) => task.title)))
    return 'handled'
  }

  if (parsed.result.kind === 'complete_task' || parsed.result.kind === 'complete_and_close_day') {
    const completed = await resolveExistingTask(ctx, user, parsed.result.title, activeTasks, current?.taskId ?? null)
    if (!completed) {
      await reply(ctx, user, T.taskCompleteUnknown)
      return 'handled'
    }
    const completedNow = await completeTask(ctx, user, completed, source)
    if (!completedNow) return 'handled'
    return parsed.result.kind === 'complete_and_close_day' ? 'close_day' : 'handled'
  }

  if (parsed.result.kind === 'start_task') {
    const next = await resolveOrCreateTask(ctx, user, parsed.result.title, activeTasks, source)
    await startTaskSession(ctx, user, next.id)
    return 'handled'
  }
  if (!current?.taskId) {
    await reply(ctx, user, T.taskSwitchNoCurrent)
    return 'handled'
  }
  if (current.state === 'paused') {
    await reply(ctx, user, T.taskSwitchPaused)
    return 'handled'
  }
  const next = await resolveOrCreateTask(ctx, user, parsed.result.title, activeTasks, source)
  await completeAndStart(ctx, user, { completeTaskId: current.taskId, start: { taskId: next.id, title: next.title } }, source)
  return 'handled'
}

export async function onVoice(
  ctx: Ctx,
  user: User,
  voice: { file_id: string; duration: number; mime_type?: string | undefined; file_size?: number | undefined },
): Promise<{ outcome: Exclude<TaskMessageOutcome, 'handled'>; text: string } | null> {
  if (voice.duration > MAX_VOICE_SECONDS) { await reply(ctx, user, T.voiceTooLong); return null }
  if (voice.file_size !== undefined && voice.file_size > MAX_VOICE_BYTES) { await reply(ctx, user, T.voiceTooLarge); return null }
  if (!ctx.stt.enabled) { await reply(ctx, user, T.voiceDisabled); return null }
  if (!allowVoice(user.tgId, ctx.now())) { await reply(ctx, user, T.voiceRateLimited); return null }

  let transcript: string
  try {
    const audio = await ctx.tg.download(voice.file_id, MAX_VOICE_BYTES)
    transcript = await ctx.stt.transcribe({
      audio,
      filename: 'voice.ogg',
      mimeType: voice.mime_type ?? 'audio/ogg',
      timeoutMs: 30_000,
    })
  } catch (error) {
    if (error instanceof TelegramError && error.code === 413) await reply(ctx, user, T.voiceTooLarge)
    else await reply(ctx, user, T.voiceFailed)
    return null
  }

  const text = transcript.replace(/\s+/g, ' ').trim().slice(0, 2_000)
  if (!text) { await reply(ctx, user, T.voiceFailed); return null }
  await logEvent(
    ctx.db,
    user.id,
    'voice_transcribed',
    { duration_seconds: voice.duration, length_chars: text.length },
    { at: ctx.now() },
  )
  await reply(ctx, user, T.voiceTranscript(text))
  const outcome = await onTaskMessage(ctx, user, text, 'voice')
  return outcome === 'handled' ? null : { outcome, text }
}
