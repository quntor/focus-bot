import type { User } from '@prisma/client'
import { llmMeter } from '../analytics/calls.js'
import { logEvent } from '../analytics/log.js'
import { workDayKey } from '../lib/day.js'
import { breakDownTask, splitLines, splitManualSteps } from '../llm/breakdown.js'
import { parseIntent } from '../llm/intent.js'
import { parseTaskMessage } from '../llm/tasks.js'
import { SttCallError } from '../stt/provider.js'
import { cancelPending } from '../outbox/queue.js'
import { creditCountedSession } from '../retention/credit.js'
import { isCounted } from '../retention/rules.js'
import { StaleTransition, transition } from '../session/fsm.js'
import { TelegramError, type Keyboard } from '../tg/client.js'
import { cb } from './callbacks.js'
import { reply, type Ctx } from './context.js'
import { recentConversationContext } from './conversation-context.js'
import { activeElapsedMinutes, activeSession, onStartButton, startTaskSession } from './session-flow.js'
import { T, hhmm } from './texts.js'
import { findOrCreateTask } from './task-store.js'

export type TaskInputSource = 'text' | 'voice'
type TaskCompletionSource = TaskInputSource | 'button'
export type TaskMessageOutcome = 'handled' | 'session_intent' | 'close_day'

export const MAX_VOICE_SECONDS = 180
export const MAX_VOICE_BYTES = 5 * 1024 * 1024
export const MAX_VOICE_PER_HOUR = 5

function sameActiveSession(
  before: Awaited<ReturnType<typeof activeSession>>,
  after: Awaited<ReturnType<typeof activeSession>>,
): boolean {
  if (!before || !after) return before === after
  return before.id === after.id && before.state === after.state && before.taskId === after.taskId && before.intentText === after.intentText
}

async function replyToFeedback(ctx: Ctx, user: User, current: Awaited<ReturnType<typeof activeSession>>): Promise<void> {
  if (current?.state === 'collecting_intent') return reply(ctx, user, T.collectingFeedback(current.intentText !== null))
  if (current?.state === 'running') return reply(ctx, user, T.runningFeedback)
  if (current?.state === 'paused') return reply(ctx, user, T.pausedFeedback)
  await reply(ctx, user, T.idleFeedback)
}

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
  if (mode === 'actions') keyboard.push([{ text: T.taskAddButton, data: cb('tasks', null, 'add') }])
  return keyboard
}

// Шаги разбора идут сразу под исходной задачей: «↳ Открыть черновик (шаг 1 из 3)».
// Шаг, чья исходная задача уже закрыта, показывается как обычная задача.
async function orderedActiveTasks(ctx: Ctx, userId: string): Promise<{ id: string; title: string }[]> {
  const active = await ctx.db.task.findMany({
    where: { userId, status: 'active' },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true, title: true, parentId: true },
  })
  const activeIds = new Set(active.map((task) => task.id))
  const parentIds = [...new Set(active.map((task) => task.parentId).filter((id): id is string => id !== null && activeIds.has(id)))]
  const allSteps = parentIds.length
    ? await ctx.db.task.findMany({
        where: { userId, parentId: { in: parentIds }, status: { not: 'dropped' } },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { id: true, parentId: true },
      })
    : []
  const isStep = (task: { parentId: string | null }) => task.parentId !== null && activeIds.has(task.parentId)
  const ordered: { id: string; title: string }[] = []
  for (const root of active.filter((task) => !isStep(task))) {
    ordered.push({ id: root.id, title: root.title })
    const siblings = allSteps.filter((step) => step.parentId === root.id)
    for (const step of active.filter((task) => task.parentId === root.id)) {
      const n = siblings.findIndex((sibling) => sibling.id === step.id) + 1
      ordered.push({ id: step.id, title: T.stepLabel(step.title, n, siblings.length) })
    }
  }
  return ordered
}

async function activeTaskPage(ctx: Ctx, user: User, page: number): Promise<TaskPage | null> {
  const all = await orderedActiveTasks(ctx, user.id)
  if (all.length === 0) return null
  const pages = Math.ceil(all.length / TASKS_PER_PAGE)
  const safePage = Math.max(0, Math.min(page, pages - 1))
  return { tasks: all.slice(safePage * TASKS_PER_PAGE, (safePage + 1) * TASKS_PER_PAGE), page: safePage, pages }
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

// Список, где нажатие на задачу сразу её запускает (или привязывает к идущему
// таймеру), а не открывает карточку.
export async function showTaskPicker(ctx: Ctx, user: User, prefix: string): Promise<void> {
  const prompt = await buildTaskStartPrompt(ctx, user, prefix)
  if (!prompt) return reply(ctx, user, T.tasksEmpty)
  await reply(ctx, user, prompt.text, prompt.keyboard)
}

async function showTaskStartPrompt(ctx: Ctx, user: User, page: number): Promise<void> {
  const prompt = await buildTaskStartPrompt(ctx, user, T.meetingPlain, page)
  if (!prompt) return reply(ctx, user, T.tasksEmpty)
  await reply(ctx, user, prompt.text, prompt.keyboard)
}

export async function showTasks(ctx: Ctx, user: User, page = 0, notice?: string, restore?: { id: string }): Promise<void> {
  const list = await activeTaskPage(ctx, user, page)
  if (!list) {
    const keyboard = [
      ...(restore ? [[{ text: T.taskRestoreButton, data: cb('task', restore.id, 'restore') }]] : []),
      [{ text: T.taskAddButton, data: cb('tasks', null, 'add') }],
    ]
    await reply(ctx, user, notice ? `${notice}\n${T.tasksEmpty}` : T.tasksEmpty, keyboard)
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

export async function onTaskOpened(ctx: Ctx, user: User, taskId: string, page: number, notice?: string): Promise<void> {
  const task = await ctx.db.task.findFirst({
    where: { id: taskId, userId: user.id, status: 'active' },
    select: { id: true, title: true },
  })
  if (!task) return reply(ctx, user, T.stale)
  await reply(ctx, user, notice ? `${notice}\n\n${T.taskActions(task.title)}` : T.taskActions(task.title), [
    [
      { text: T.taskStartButton, data: cb('task', task.id, 'start') },
      { text: T.taskCompleteButton, data: cb('task', task.id, 'done') },
    ],
    [
      { text: T.taskEditButton, data: cb('task', task.id, 'edit') },
      { text: T.taskDropButton, data: cb('task', task.id, 'drop') },
    ],
    [{ text: T.taskBreakdownButton, data: cb('task', task.id, 'split') }],
    [{ text: T.tasksBackButton, data: cb('tasks', null, `p${page}`) }],
  ])
}

export async function onTaskSelected(ctx: Ctx, user: User, taskId: string): Promise<void> {
  await startTaskSession(ctx, user, taskId)
}

export async function onTaskEditRequested(ctx: Ctx, user: User, taskId: string): Promise<void> {
  const task = await ctx.db.task.findFirst({
    where: { id: taskId, userId: user.id, status: 'active' },
    select: { id: true, title: true },
  })
  if (!task) return reply(ctx, user, T.stale)
  await ctx.db.user.update({ where: { id: user.id }, data: { pendingInput: `task_edit:${task.id}` } })
  await reply(ctx, user, T.taskEditAsk(task.title))
}

export async function onTaskEditText(ctx: Ctx, user: User, taskId: string, rawTitle: string): Promise<void> {
  const title = rawTitle.replace(/\s+/g, ' ').trim().slice(0, 80)
  if (!title) return reply(ctx, user, T.taskEditInvalid)

  const result = await ctx.db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${user.id}))`
    const waiting = await tx.user.findFirst({
      where: { id: user.id, pendingInput: `task_edit:${taskId}` },
      select: { id: true },
    })
    if (!waiting) return 'stale' as const
    const task = await tx.task.findFirst({
      where: { id: taskId, userId: user.id, status: 'active' },
      select: { id: true },
    })
    if (!task) {
      await tx.user.update({ where: { id: user.id }, data: { pendingInput: 'none' } })
      return 'stale' as const
    }
    const active = await tx.task.findMany({
      where: { userId: user.id, status: 'active', id: { not: task.id } },
      select: { title: true },
    })
    if (active.some((candidate) => normalize(candidate.title) === normalize(title))) return 'duplicate' as const

    await tx.task.update({ where: { id: task.id }, data: { title } })
    await tx.focusSession.updateMany({
      where: { userId: user.id, taskId: task.id, state: { in: ['collecting_intent', 'running', 'paused'] } },
      data: { intentText: title },
    })
    await tx.user.update({ where: { id: user.id }, data: { pendingInput: 'none' } })
    return 'renamed' as const
  })

  if (result === 'stale') return reply(ctx, user, T.stale)
  if (result === 'duplicate') return reply(ctx, user, T.taskEditDuplicate)
  await reply(ctx, user, T.taskRenamed(title))
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

// --- Добавить задачу без старта. Ожидание — pendingInput task_add.
export async function onTaskAddRequested(ctx: Ctx, user: User): Promise<void> {
  await ctx.db.user.update({ where: { id: user.id }, data: { pendingInput: 'task_add' } })
  await reply(ctx, user, T.taskAddAsk)
}

const ADD_MAX = 10

export async function onTaskAddText(ctx: Ctx, user: User, text: string, source: TaskInputSource): Promise<void> {
  const lines = splitLines(text)
  if (!lines.length) return reply(ctx, user, T.taskAddAsk)
  const claimed = await ctx.db.user.updateMany({ where: { id: user.id, pendingInput: 'task_add' }, data: { pendingInput: 'none' } })
  if (claimed.count !== 1) return reply(ctx, user, T.stale)
  const saved = await captureTasks(ctx, user, lines.slice(0, ADD_MAX), source)
  if (!saved.length) return reply(ctx, user, T.tasksParseFailed)
  // Лишнее не пропадает молча: человек узнаёт, что записано не всё.
  const trimmed = lines.length > ADD_MAX ? T.tasksTrimmed(ADD_MAX) : null
  // Одна задача — сразу её карточка: «Начать» или «Разобрать» в одно нажатие.
  if (saved.length === 1) {
    const one = saved[0]!
    return onTaskOpened(ctx, user, one.id, 0, one.created ? T.taskAdded(one.title) : T.taskExists(one.title))
  }
  await showTasks(ctx, user, 0, [T.tasksCaptured(saved.map((task) => task.title)), trimmed].filter(Boolean).join('\n'))
}

// --- Разбор задачи на шаги. Ожидание ответа — pendingInput task_split:<id>;
// если модель не ответила — task_split_manual:<id>, и следующий текст
// записывается как шаги без модели. Шаги — обычные задачи: «Начать» и
// «Завершить» у них работают как у любой другой.
const SPLIT_ANSWER_MAX = 500

export async function onTaskBreakdownRequested(ctx: Ctx, user: User, taskId: string): Promise<void> {
  const task = await ctx.db.task.findFirst({
    where: { id: taskId, userId: user.id, status: 'active' },
    select: { id: true, title: true },
  })
  if (!task) return reply(ctx, user, T.stale)
  await ctx.db.$transaction(async (tx) => {
    await tx.user.update({ where: { id: user.id }, data: { pendingInput: `task_split:${task.id}` } })
    await logEvent(tx, user.id, 'task_breakdown_requested', { task_id: task.id }, { at: ctx.now() })
  })
  await reply(ctx, user, T.breakdownAsk(task.title), [[{ text: T.breakdownAuto, data: cb('task', task.id, 'splitauto') }]])
}

// answer === null — «Предложи сам».
//
// Раунды: task_split — первый ответ, модель может задать уточняющий вопрос;
// task_split_clarify — ответ на него, второго вопроса нет: если задача всё ещё
// размыта, просим одно действие на 10 минут и записываем его как есть
// (task_split_manual). Шаги из общих слов хуже, чем честный вопрос.
export async function onTaskBreakdownAnswer(
  ctx: Ctx,
  user: User,
  taskId: string,
  answer: string | null,
  source: TaskInputSource,
  contextEventId: number | null = null,
): Promise<void> {
  const firstRound = user.pendingInput === `task_split:${taskId}`
  const clarifying = user.pendingInput === `task_split_clarify:${taskId}`
  const manual = user.pendingInput === `task_split_manual:${taskId}`
  if (!firstRound && !clarifying && !manual) return reply(ctx, user, T.stale)
  const task = await ctx.db.task.findFirst({
    where: { id: taskId, userId: user.id, status: 'active' },
    select: { id: true, title: true },
  })
  if (!task) {
    await ctx.db.user.updateMany({ where: { id: user.id, pendingInput: user.pendingInput }, data: { pendingInput: 'none' } })
    return reply(ctx, user, T.stale)
  }
  const text = answer?.trim().slice(0, SPLIT_ANSWER_MAX) ?? null
  const moveTo = async (pendingInput: string) =>
    (await ctx.db.user.updateMany({ where: { id: user.id, pendingInput: user.pendingInput }, data: { pendingInput } })).count === 1

  let steps: string[]
  let mode: 'answered' | 'auto' | 'manual'
  let llmUsed = false
  if (manual) {
    if (text === null) return reply(ctx, user, T.breakdownManual)
    steps = splitManualSteps(text)
    mode = 'manual'
  } else {
    // Во втором раунде модели нужен первый ответ и её же вопрос — они в
    // коротком окне диалога. Текущая реплика передаётся отдельно, как answer.
    const recentContext = clarifying ? recentConversationContext(user.id, ctx.now(), { beforeEventId: contextEventId }) : []
    const out = await breakDownTask(
      ctx.llm,
      { title: task.title, answer: text, recentContext },
      llmMeter(ctx, user.id, 'task_breakdown', null),
    )
    if (out.ok && out.value.kind === 'question') {
      await logEvent(ctx.db, user.id, 'task_breakdown_vague', { task_id: task.id, round: clarifying ? 2 : 1 }, { at: ctx.now() })
      if (firstRound) {
        if (!(await moveTo(`task_split_clarify:${task.id}`))) return reply(ctx, user, T.stale)
        return reply(ctx, user, out.value.question)
      }
      if (!(await moveTo(`task_split_manual:${task.id}`))) return reply(ctx, user, T.stale)
      return reply(ctx, user, T.breakdownFirstAction)
    }
    if (out.ok && out.value.kind === 'steps') {
      steps = out.value.steps
      mode = text === null ? 'auto' : 'answered'
      llmUsed = true
    } else {
      await logEvent(ctx.db, user.id, 'llm_fallback', { stage: 'breakdown', reason: out.ok ? 'invalid' : out.reason }, { at: ctx.now() })
      // Человек уже перечислил шаги — записываем их и без модели.
      const listed = text === null ? [] : splitManualSteps(text)
      if (listed.length < 2) {
        if (!(await moveTo(`task_split_manual:${task.id}`))) return reply(ctx, user, T.stale)
        return reply(ctx, user, T.breakdownManual)
      }
      steps = listed
      mode = 'manual'
    }
  }
  steps = steps.filter((step) => normalize(step) !== normalize(task.title))
  if (!steps.length) {
    // Писать шаги самому — значит следующий ответ не уходит снова к модели.
    await ctx.db.user.updateMany({ where: { id: user.id, pendingInput: user.pendingInput }, data: { pendingInput: `task_split_manual:${task.id}` } })
    return reply(ctx, user, T.breakdownManual)
  }

  // Ожидание снимается до записи: пока шла модель, человек мог нажать другое.
  const claimed = await ctx.db.user.updateMany({ where: { id: user.id, pendingInput: user.pendingInput }, data: { pendingInput: 'none' } })
  if (claimed.count !== 1) return reply(ctx, user, T.stale)
  // Повторный разбор заменяет незакрытые и ещё не начатые шаги, а не копит их.
  await ctx.db.task.updateMany({
    where: { userId: user.id, parentId: task.id, status: 'active', sessionsCount: 0 },
    data: { status: 'dropped' },
  })
  const saved = await captureTasks(ctx, user, steps, source, { parentId: task.id })
  if (!saved.length) return reply(ctx, user, T.tasksParseFailed)
  await logEvent(ctx.db, user.id, 'task_breakdown_done', { task_id: task.id, mode, steps: saved.length, llm_used: llmUsed }, { at: ctx.now() })
  await reply(ctx, user, T.breakdownDone(task.title, saved.map((step) => step.title)), [
    [{ text: T.breakdownStartFirst, data: cb('task', saved[0]!.id, 'start') }],
    [{ text: T.tasksButton, data: cb('tasks', null, 'p0') }],
  ])
}

// created — задача новая; false — такая уже была в активных. Шаги разбора
// передают parentId исходной задачи.
async function captureTasks(ctx: Ctx, user: User, titles: string[], source: TaskInputSource, opts: { parentId?: string } = {}) {
  return ctx.db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${user.id}))`
    const selected: { id: string; title: string; created: boolean }[] = []
    // Порядок списка — порядок в сообщении: createdAt с шагом в миллисекунду,
    // иначе при равном времени порядок решал бы случайный id.
    const base = ctx.now().getTime()
    for (const [i, raw] of titles.entries()) {
      if (!normalize(raw)) continue
      selected.push(await findOrCreateTask(tx, { userId: user.id, title: raw, now: new Date(base + i), parentId: opts.parentId ?? null }))
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
  sessionId: string | null,
): Promise<{ id: string; title: string }> {
  const parsed = activeTasks.length
    ? await parseIntent(ctx.llm, { text: title, tasks: activeTasks, profile: user.profileText }, llmMeter(ctx, user.id, 'task_match', sessionId))
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
  sessionId: string | null,
): Promise<{ id: string; title: string } | null> {
  if (title === null) {
    if (!currentTaskId) return null
    return ctx.db.task.findFirst({
      where: { id: currentTaskId, userId: user.id, status: 'active' },
      select: { id: true, title: true },
    })
  }
  if (!activeTasks.length) return null

  const parsed = await parseIntent(ctx.llm, { text: title, tasks: activeTasks, profile: user.profileText }, llmMeter(ctx, user.id, 'task_match', sessionId))
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
  source: TaskCompletionSource,
  showList = false,
  keepRunning = false,
): Promise<boolean> {
  const now = ctx.now()
  let doneTitle = task.title
  let runningUntil: Date | null | undefined
  let onBreak = false
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
      } else if (
        keepRunning &&
        current?.taskId === completed.id &&
        (current.state === 'running' || current.state === 'paused')
      ) {
        // Сессия — заход, а не задача: период (или перерыв) продолжается без
        // задачи, следующую человек выберет, и она получит время с этого момента.
        // Закрытие задачи сессию не заканчивает никогда (решение 01.10).
        const released = await tx.focusSession.updateMany({
          where: { id: current.id, userId: user.id, state: current.state, taskId: completed.id },
          data: { taskId: null, intentText: null, scope: 'step' },
        })
        if (released.count !== 1) throw new StaleTransition()
        if (current.state === 'running') runningUntil = current.plannedEndAt
        else onBreak = true
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
        await cancelPending(tx, { userId: user.id, idempotencyKey: { startsWith: `session_end:${current.id}` } })
        await logEvent(
          tx,
          user.id,
          'session_completed',
          { session_id: current.id, outcome: 'done', elapsed_minutes: elapsed, early, counted },
          { at: now, sessionId: current.id },
        )
        if (counted) {
          await creditCountedSession(tx, { userId: user.id, sessionId: current.id, dayKey: workDayKey(now, user.timezone), at: now })
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
  if (runningUntil !== undefined) {
    const notice = T.taskDoneTimerRuns(doneTitle, runningUntil ? hhmm(runningUntil, user.timezone) : null)
    const prompt = await buildTaskStartPrompt(ctx, user, notice)
    if (prompt) await reply(ctx, user, prompt.text, prompt.keyboard)
    else await reply(ctx, user, `${notice}\n${T.taskDoneTimerRunsEmpty}`)
  } else if (onBreak) await reply(ctx, user, `${T.taskCompleted(doneTitle)}\n${T.breakChoice}`)
  else if (showList) await showTasks(ctx, user, 0, T.taskCompleted(doneTitle))
  else await reply(ctx, user, T.taskCompleted(doneTitle))
  await offerParentClose(ctx, user, task.id)
  return true
}

// Закрыт последний шаг разбора — предлагаем закрыть и исходную задачу.
// Сама она не закрывается: шаги могли быть не всей работой.
async function offerParentClose(ctx: Ctx, user: User, stepId: string): Promise<void> {
  const step = await ctx.db.task.findFirst({ where: { id: stepId, userId: user.id }, select: { parentId: true } })
  if (!step?.parentId) return
  const parent = await ctx.db.task.findFirst({ where: { id: step.parentId, userId: user.id, status: 'active' }, select: { id: true, title: true } })
  if (!parent) return
  const left = await ctx.db.task.count({ where: { userId: user.id, parentId: parent.id, status: 'active' } })
  if (left > 0) return
  await reply(ctx, user, T.allStepsDone(parent.title), [[{ text: taskLabel(T.closeParentButton(parent.title)), data: cb('task', parent.id, 'done') }]])
}

export async function onTaskCompleted(ctx: Ctx, user: User, taskId: string): Promise<void> {
  const task = await ctx.db.task.findFirst({
    where: { id: taskId, userId: user.id, status: 'active' },
    select: { id: true, title: true },
  })
  if (!task) return reply(ctx, user, T.stale)
  await completeTask(ctx, user, task, 'button', true, true)
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
  let keptRunning = false
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
        if (!next) next = await tx.task.findUniqueOrThrow({ where: { id: (await findOrCreateTask(tx, { userId: user.id, title: input.start.title, now })).id } })
      }
      if (!next || next.id === completed.id) throw new StaleTransition()

      if (current?.state === 'running') {
        const changed = await tx.focusSession.updateMany({
          where: { id: current.id, userId: user.id, state: 'running', taskId: completed.id },
          data: { taskId: next.id, intentText: next.title, scope: 'step' },
        })
        if (changed.count !== 1) throw new StaleTransition()
        await tx.task.updateMany({
          where: { id: completed.id, userId: user.id, sessionsCount: { gt: 0 } },
          data: { sessionsCount: { decrement: 1 } },
        })
        await tx.task.updateMany({
          where: { id: next.id, userId: user.id, status: 'active' },
          data: { sessionsCount: { increment: 1 }, lastSessionAt: now },
        })
        keptRunning = true
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
      await logEvent(tx, user.id, 'task_completed', { task_id: completed.id, source }, { at: now, sessionId: current?.id })
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
  if (keptRunning) await reply(ctx, user, T.taskSwitchedRunning(doneTitle, selectedNext.title))
  else {
    await reply(ctx, user, T.taskSwitched(doneTitle, selectedNext.title))
    await startTaskSession(ctx, user, selectedNext.id)
  }
  await offerParentClose(ctx, user, input.completeTaskId)
}

// Задача последней сессии, закрытой не больше двух часов назад, — если она
// ещё активна. Нужна, чтобы «эту закончил» на отдыхе понималось.
async function recentSessionTaskId(ctx: Ctx, userId: string): Promise<string | null> {
  const last = await ctx.db.focusSession.findFirst({
    where: { userId, state: 'finished', taskId: { not: null }, finishedAt: { gte: new Date(ctx.now().getTime() - 2 * 60 * 60_000) } },
    orderBy: { finishedAt: 'desc' },
    select: { taskId: true },
  })
  if (!last?.taskId) return null
  const task = await ctx.db.task.findFirst({ where: { id: last.taskId, userId, status: 'active' }, select: { id: true } })
  return task?.id ?? null
}

// Модель только классифицирует свободную речь. Вызывающий выполняет
// обычное намерение или закрытие дня; операции с задачами делаются здесь.
export async function onTaskMessage(
  ctx: Ctx,
  user: User,
  text: string,
  source: TaskInputSource,
  contextEventId: number | null = null,
): Promise<TaskMessageOutcome> {
  const current = await activeSession(ctx, user.id)
  // «Эту закончил» сразу после сессии — про её задачу, а не «не понял».
  const currentTaskId = current?.taskId ?? (current ? null : await recentSessionTaskId(ctx, user.id))
  const storedTasks = await ctx.db.task.findMany({
    where: { userId: user.id, status: 'active' },
    orderBy: { createdAt: 'desc' },
    take: 20,
    select: { id: true, title: true },
  })
  // Текущая задача всегда t1: тогда фразы «эту сделал» устойчивы к NULL-order
  // базы и не зависят от того, когда создавались остальные дела.
  const activeTasks = currentTaskId
    ? [...storedTasks.filter((task) => task.id === currentTaskId), ...storedTasks.filter((task) => task.id !== currentTaskId)]
    : storedTasks
  const sessionState = current?.state === 'collecting_intent' || current?.state === 'running' || current?.state === 'paused'
    ? current.state
    : 'idle'
  const parsed = await parseTaskMessage(
    ctx.llm,
    {
      text,
      tasks: activeTasks,
      currentTaskId,
      sessionState,
      recentContext: recentConversationContext(user.id, ctx.now(), { beforeEventId: contextEventId }),
    },
    llmMeter(ctx, user.id, 'tasks', current?.id ?? null),
  )
  const fresh = await activeSession(ctx, user.id)
  if (parsed.result && !sameActiveSession(current, fresh)) {
    await logEvent(ctx.db, user.id, 'route_stale', { stage: 'tasks' }, { at: ctx.now(), sessionId: current?.id })
    await reply(ctx, user, T.stale)
    return 'handled'
  }
  if (!parsed.result) {
    const reason = parsed.failure && !parsed.failure.ok ? parsed.failure.reason : 'invalid'
    await logEvent(ctx.db, user.id, 'llm_fallback', { stage: 'tasks', reason }, { at: ctx.now(), sessionId: current?.id })
    // В сборке без LLM сохраняем базовый текстовый старт сессии. Ошибка
    // включённой модели не даёт частичных операций: просим повторить.
    if (reason === 'disabled' || reason === 'budget') return 'session_intent'
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
  if (parsed.result.kind === 'feedback') {
    await replyToFeedback(ctx, user, current)
    return 'handled'
  }
  if (parsed.result.kind === 'close_day') return 'close_day'
  if (parsed.result.kind === 'capture') {
    const tasks = await captureTasks(ctx, user, parsed.result.titles, source)
    if (!tasks.length) {
      await reply(ctx, user, T.tasksParseFailed)
      return 'handled'
    }
    if (tasks.length === 1) await onTaskOpened(ctx, user, tasks[0]!.id, 0, tasks[0]!.created ? T.taskAdded(tasks[0]!.title) : T.taskExists(tasks[0]!.title))
    else await showTasks(ctx, user, 0, T.tasksCaptured(tasks.map((task) => task.title)))
    return 'handled'
  }

  if (parsed.result.kind === 'complete_task' || parsed.result.kind === 'complete_and_close_day') {
    const completed = await resolveExistingTask(ctx, user, parsed.result.title, activeTasks, currentTaskId, current?.id ?? null)
    if (!completed) {
      await reply(ctx, user, T.taskCompleteUnknown)
      return 'handled'
    }
    const completedNow = await completeTask(ctx, user, completed, source, false, parsed.result.kind === 'complete_task')
    if (!completedNow) return 'handled'
    return parsed.result.kind === 'complete_and_close_day' ? 'close_day' : 'handled'
  }

  if (parsed.result.kind === 'start_task') {
    const next = await resolveOrCreateTask(ctx, user, parsed.result.title, activeTasks, source, current?.id ?? null)
    await startTaskSession(ctx, user, next.id)
    return 'handled'
  }
  if (!currentTaskId) {
    await reply(ctx, user, T.taskSwitchNoCurrent)
    return 'handled'
  }
  if (current?.state === 'paused') {
    await reply(ctx, user, T.taskSwitchPaused)
    return 'handled'
  }
  const next = await resolveOrCreateTask(ctx, user, parsed.result.title, activeTasks, source, current?.id ?? null)
  await completeAndStart(ctx, user, { completeTaskId: currentTaskId, start: { taskId: next.id, title: next.title } }, source)
  return 'handled'
}

export async function transcribeVoice(
  ctx: Ctx,
  user: User,
  voice: { file_id: string; duration: number; mime_type?: string | undefined; file_size?: number | undefined },
): Promise<string | null> {
  if (voice.duration > MAX_VOICE_SECONDS) { await reply(ctx, user, T.voiceTooLong); return null }
  if (voice.file_size !== undefined && voice.file_size > MAX_VOICE_BYTES) { await reply(ctx, user, T.voiceTooLarge); return null }
  if (!ctx.stt.enabled) { await reply(ctx, user, T.voiceDisabled); return null }
  if (!allowVoice(user.tgId, ctx.now())) { await reply(ctx, user, T.voiceRateLimited); return null }
  const meter = llmMeter(ctx, user.id, 'voice_transcription', null)
  // Голос без модели не разобрать: сверх дневного лимита — просим текст.
  if (meter.allow && !(await meter.allow())) { await reply(ctx, user, T.voiceBudget); return null }

  let audio: Uint8Array
  try {
    audio = await ctx.tg.download(voice.file_id, MAX_VOICE_BYTES)
  } catch (error) {
    if (error instanceof TelegramError && error.code === 413) await reply(ctx, user, T.voiceTooLarge)
    else await reply(ctx, user, T.voiceFailed)
    return null
  }

  const startedAt = performance.now()
  let transcript: string
  try {
    transcript = await ctx.stt.transcribe({
      audio,
      filename: 'voice.ogg',
      mimeType: voice.mime_type ?? 'audio/ogg',
      timeoutMs: 30_000,
    })
    const normalized = transcript.replace(/\s+/g, ' ').trim().slice(0, 2_000)
    await meter({
      latencyMs: Math.round(performance.now() - startedAt),
      status: normalized ? 'ok' : 'invalid',
      errorCode: normalized ? null : 'schema',
      model: ctx.stt.model,
      usage: null,
    })
    transcript = normalized
  } catch (error) {
    const code = error instanceof SttCallError ? error.code : 'error'
    await meter({
      latencyMs: Math.round(performance.now() - startedAt),
      status: code === 'timeout' ? 'timeout' : 'error',
      errorCode: code,
      model: ctx.stt.model,
      usage: null,
    })
    await reply(ctx, user, T.voiceFailed)
    return null
  }

  const text = transcript
  if (!text) { await reply(ctx, user, T.voiceFailed); return null }
  await logEvent(
    ctx.db,
    user.id,
    'voice_transcribed',
    { duration_seconds: voice.duration, length_chars: text.length },
    { at: ctx.now() },
  )
  await reply(ctx, user, T.voiceTranscript(text))
  return text
}
