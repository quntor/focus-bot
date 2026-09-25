import type { User } from '@prisma/client'
import { logEvent } from '../analytics/log.js'
import { dayKey } from '../lib/day.js'
import { parseTaskMessage } from '../llm/tasks.js'
import { cancelPending } from '../outbox/queue.js'
import { creditCountedSession } from '../retention/credit.js'
import { isCounted } from '../retention/rules.js'
import { StaleTransition, transition } from '../session/fsm.js'
import { TelegramError, type Keyboard } from '../tg/client.js'
import { cb } from './callbacks.js'
import { reply, type Ctx } from './context.js'
import { activeElapsedMinutes, activeSession, onIntentText, onStartButton, startTaskSession } from './session-flow.js'
import { T } from './texts.js'

export type TaskInputSource = 'text' | 'voice'

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

// Обычное «поработаю над отчётом» сохраняет старый быстрый сценарий. Парсер
// списка зовём, только когда человек явно управляет задачами; voice проверяется
// всегда, потому что это новый вход и одна запись часто содержит целый список.
export function shouldParseTaskMessage(text: string): boolean {
  const compact = text.replace(/\s+/g, ' ').trim()
  return [
    /(?:добавь|добавить|запиши|записать|создай|создать).{0,30}задач/iu,
    /(?:сегодня|на сегодня).{0,30}(?:хочу|нужно|надо|планирую).{0,30}(?:сделать|задач|дел)/iu,
    /(?:сделал|сделала|закончил|закончила|готово).{0,100}(?:приступаю|перехожу|начинаю)/iu,
  ].some((pattern) => pattern.test(compact))
}

const TASKS_PER_PAGE = 6

function taskLabel(title: string): string {
  return title.replace(/\s+/g, ' ').trim().slice(0, 42)
}

function taskKeyboard(
  tasks: { id: string; title: string }[],
  page: number,
  pages: number,
  restore?: { id: string },
): Keyboard {
  const keyboard: Keyboard = tasks.map((task) => [
    { text: `▶️ ${taskLabel(task.title)}`, data: cb('task', task.id, 'start') },
    { text: '🗑', data: cb('task', task.id, 'drop') },
  ])
  const navigation = []
  if (page > 0) navigation.push({ text: '← Назад', data: cb('tasks', null, `p${page - 1}`) })
  if (page + 1 < pages) navigation.push({ text: 'Дальше →', data: cb('tasks', null, `p${page + 1}`) })
  if (navigation.length) keyboard.push(navigation)
  if (restore) keyboard.push([{ text: T.taskRestoreButton, data: cb('task', restore.id, 'restore') }])
  return keyboard
}

export async function showTasks(ctx: Ctx, user: User, page = 0, notice?: string, restore?: { id: string }): Promise<void> {
  const count = await ctx.db.task.count({ where: { userId: user.id, status: 'active' } })
  if (count === 0) {
    await reply(ctx, user, notice ? `${notice}\n${T.tasksEmpty}` : T.tasksEmpty, restore ? [[{ text: T.taskRestoreButton, data: cb('task', restore.id, 'restore') }]] : undefined)
    return
  }
  const pages = Math.ceil(count / TASKS_PER_PAGE)
  const safePage = Math.max(0, Math.min(page, pages - 1))
  const tasks = await ctx.db.task.findMany({
    where: { userId: user.id, status: 'active' },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    skip: safePage * TASKS_PER_PAGE,
    take: TASKS_PER_PAGE,
    select: { id: true, title: true },
  })
  await reply(ctx, user, T.tasksList(tasks.map((task) => task.title), safePage, pages, notice), taskKeyboard(tasks, safePage, pages, restore))
}

export async function onSessionStart(ctx: Ctx, user: User): Promise<void> {
  await onStartButton(ctx, user)
  const running = await activeSession(ctx, user.id)
  if (running?.state !== 'running') return
  const count = await ctx.db.task.count({ where: { userId: user.id, status: 'active' } })
  if (count > 0) await showTasks(ctx, user, 0, T.tasksChoose)
}

export async function onTasksPage(ctx: Ctx, user: User, arg: string): Promise<void> {
  const match = /^p(\d{1,4})$/.exec(arg)
  if (!match) return reply(ctx, user, T.stale)
  await showTasks(ctx, user, Number(match[1]))
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

// true — сообщение полностью обработано как управление задачами; false — это
// обычное намерение, вызывающий продолжает прежний session-flow.
export async function onTaskMessage(ctx: Ctx, user: User, text: string, source: TaskInputSource): Promise<boolean> {
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
    await reply(ctx, user, T.tasksParseFailed)
    return true
  }

  const count = parsed.result.kind === 'capture' ? parsed.result.titles.length : parsed.result.kind === 'complete_and_start' ? 1 : 0
  await logEvent(ctx.db, user.id, 'tasks_parsed', { kind: parsed.result.kind, count }, { at: ctx.now(), sessionId: current?.id })
  if (parsed.result.kind === 'session_intent') return false
  if (parsed.result.kind === 'capture') {
    const tasks = await captureTasks(ctx, user, parsed.result.titles, source)
    if (!tasks.length) {
      await reply(ctx, user, T.tasksParseFailed)
      return true
    }
    await showTasks(ctx, user, 0, T.tasksCaptured(tasks.map((task) => task.title)))
    return true
  }

  await completeAndStart(ctx, user, parsed.result, source)
  return true
}

export async function onVoice(
  ctx: Ctx,
  user: User,
  voice: { file_id: string; duration: number; mime_type?: string | undefined; file_size?: number | undefined },
): Promise<void> {
  if (voice.duration > MAX_VOICE_SECONDS) return reply(ctx, user, T.voiceTooLong)
  if (voice.file_size !== undefined && voice.file_size > MAX_VOICE_BYTES) return reply(ctx, user, T.voiceTooLarge)
  if (!ctx.stt.enabled) return reply(ctx, user, T.voiceDisabled)
  if (!allowVoice(user.tgId, ctx.now())) return reply(ctx, user, T.voiceRateLimited)

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
    if (error instanceof TelegramError && error.code === 413) return reply(ctx, user, T.voiceTooLarge)
    return reply(ctx, user, T.voiceFailed)
  }

  const text = transcript.replace(/\s+/g, ' ').trim().slice(0, 2_000)
  if (!text) return reply(ctx, user, T.voiceFailed)
  await logEvent(
    ctx.db,
    user.id,
    'voice_transcribed',
    { duration_seconds: voice.duration, length_chars: text.length },
    { at: ctx.now() },
  )
  await reply(ctx, user, T.voiceTranscript(text))
  if (!(await onTaskMessage(ctx, user, text, 'voice'))) await onIntentText(ctx, user, text)
}
