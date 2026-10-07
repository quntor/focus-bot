import { addDays, dayKey } from '../lib/day.js'
import { localDateTime, nextLocalTime } from '../lib/time.js'
import { taskNumberPrompt } from './task-number-prompt.js'
import type { PendingAnswer } from '../llm/router.js'
import { inputTransaction } from './input-lock.js'
import { randomUUID } from 'node:crypto'
import type { Prisma, User } from '@prisma/client'
import { logEvent } from '../analytics/log.js'
import { llmMeter } from '../analytics/calls.js'
import { parseSemanticRoute, type SemanticRoute, type SemanticRouteName } from '../llm/router.js'
import { decodeReportAnswer } from '../llm/report.js'
import { StaleTransition } from '../session/fsm.js'
import { cb } from './callbacks.js'
import { latestInputId, questionContext, recentConversationContext } from './conversation-context.js'
import { reply, type Ctx } from './context.js'
import * as session from './session-flow.js'
import * as tasks from './tasks.js'
import * as day from './day-flow.js'
import { T } from './texts.js'
import { onReminderAction } from '../reminders/actions.js'

// Short-lived dialogue data, not an action receipt. Restarts fail closed.
const TTL = 10 * 60_000
const MAX_CHOICES = 1000
const choices = new Map<string, { userId: string; at: number; fingerprint: string; text: string; via: 'text' | 'voice'; route?: SemanticRoute }>()
export function invalidateSemanticChoices(userId: string): void {
  for (const [id, choice] of choices) if (choice.userId === userId) choices.delete(id)
}
function currentInput(ctx: Ctx, userId: string, inputId: number | null): boolean {
  return ctx.isCurrentInput ? ctx.isCurrentInput() : latestInputId(userId, ctx.now()) === inputId
}
function pendingType(pending: string) {
  const prefix = pending.split(':')[0]!
  const known = ['retro', 'task_split_clarify', 'task_split_manual', 'none', 'report_text', 'session_end', 'running_work', 'running_duration', 'running_task_choice', 'task_add', 'task_edit', 'task_split', 'task_split_manual', 'timezone', 'settings_timezone', 'start_time', 'ritual', 'profile_ritual', 'meeting_time', 'meeting_time_soft', 'morning_time', 'profile'] as const
  return known.find((value) => value === prefix) ?? 'other'
}
async function snapshot(ctx: Ctx, userId: string, db: Ctx['db'] | Prisma.TransactionClient = ctx.db) {
  const [user, active, last, report, pool] = await Promise.all([
    db.user.findUnique({ where: { id: userId } }),
    db.focusSession.findFirst({ where: { userId, state: { in: ['collecting_intent', 'running', 'paused'] } } }),
    db.focusSession.findFirst({ where: { userId, state: 'finished', finishedAt: { gte: new Date(ctx.now().getTime() - 2 * 60 * 60_000) } }, orderBy: [{ finishedAt: 'desc' }, { id: 'asc' }] }),
    session.pendingReportSession(db, userId, ctx.now()),
    db.task.findMany({ where: { userId, status: 'active' }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: 20 }),
  ])
  const relevantIds = [...new Set([active?.taskId, last?.taskId, report?.taskId].filter((id): id is string => !!id))]
  const relevant = relevantIds.length ? await db.task.findMany({ where: { userId, id: { in: relevantIds } } }) : []
  const ownedTasks = [...relevant.sort((a, b) => relevantIds.indexOf(a.id) - relevantIds.indexOf(b.id)), ...pool.filter(t => !relevantIds.includes(t.id))].slice(0, 20)
  const labelledTasks = ownedTasks.map((task, i) => ({ ...task, label: `t${i + 1}` }))
  // Whole persisted state stays local. The model sees only a bounded projection.
  const fingerprint = JSON.stringify({ user: user && { pendingInput: user.pendingInput, timezone: user.timezone, technique: user.technique, profileText: user.profileText }, active, last, report, ownedTasks })
  return { user, active, last, report, labelledTasks, fingerprint }
}
type Snapshot = Awaited<ReturnType<typeof snapshot>>
function allowedRoutes(s: Snapshot): SemanticRouteName[] {
  const pending = s.user!.pendingInput
  if (['timezone', 'start_time', 'ritual'].includes(pending)) return ['answer_pending', 'feedback', 'control', 'clarify']
  const routes: SemanticRouteName[] = ['new_task', 'capture', 'close_day', 'feedback', 'control', 'task_action', 'schedule_meeting', 'clarify', 'unclear']
  if (pending !== 'none' && pending !== 'report_text' && !pending.startsWith('session_end:')) routes.push('answer_pending')
  if (s.report && !s.active) routes.push('report')
  routes.push('break')
  if (s.active?.state === 'running') routes.push('session_help', 'end_session')
  if (s.active?.state === 'collecting_intent' && s.active.intentText && s.active.taskId) routes.push('intent_step')
  if (s.active?.state === 'running' || s.active?.state === 'paused' || (!s.active && s.last?.intentText) || (s.active?.state === 'collecting_intent' && s.active.taskId)) routes.push('continue_same')
  return routes
}
function sessionProjection(value: Snapshot['active'], pending: string, labelledTasks: Snapshot['labelledTasks']) {
  if (!value) return null
  return { state: value.state, task: labelledTasks.find(t => t.id === value.taskId)?.label ?? null, work: value.intentText, scope: value.scope, startedAt: value.startedAt?.toISOString() ?? null, pausedAt: value.pausedAt?.toISOString() ?? null, plannedEndAt: value.plannedEndAt?.toISOString() ?? null, plannedMinutes: value.plannedMinutes, outcome: value.outcome,
    awaitingOutcome: value.state === 'running' && pending === `session_end:${value.id}`,
    continueSuggested: value.continueSuggested, restChoice: value.restChoice }
}
type Control = (ctx: Ctx, user: User, action: string, value: string | null) => Promise<void>
type PendingHandler = (ctx: Ctx, user: User, text: string, via: 'text' | 'voice', contextEventId: number | null, answer?: PendingAnswer) => Promise<void>
export async function routeSemanticInput(ctx: Ctx, user: User, text: string, via: 'text' | 'voice', contextEventId: number | null, handlePending: PendingHandler, control?: Control): Promise<void> {
  invalidateSemanticChoices(user.id)
  if (!ctx.llm.enabled) return reply(ctx, user, T.cannotInterpret, undefined, { informational: true })
  const before = await snapshot(ctx, user.id)
  if (!before.user) return
  const inputId = contextEventId
  if (!currentInput(ctx, user.id, inputId)) return
  const numbers = await taskNumberPrompt(ctx, user.id)
  const question = questionContext(user.id, before.user.pendingInput, ctx.now())
  const out = await parseSemanticRoute(ctx.llm, {
    text, now: ctx.now().toISOString(), timezone: before.user.timezone, taskNumbers: numbers?.choices.flatMap(c => { const task = before.labelledTasks.find(t => t.id === c.task_id); return task ? [{ number: c.number, task: task.label, mode: c.mode }] : [] }), pending: pendingType(before.user.pendingInput), pendingAgeSeconds: question.ageSeconds,
    session: sessionProjection(before.active, before.user.pendingInput, before.labelledTasks), lastSession: sessionProjection(before.last, before.user.pendingInput, before.labelledTasks), reportSession: sessionProjection(before.report, before.user.pendingInput, before.labelledTasks), lastQuestion: question.type,
    recentContext: recentConversationContext(user.id, ctx.now(), { beforeEventId: contextEventId }),
    tasks: before.labelledTasks.map(({ label, title, status }) => ({ label, title, status: status as 'active' | 'done' })),
    allowedRoutes: allowedRoutes(before),
  }, llmMeter(ctx, user.id, 'semantic_router', before.active?.id ?? before.report?.id ?? null))
  const fresh = await snapshot(ctx, user.id)
  if (!fresh.user) return
  if (before.fingerprint !== fresh.fingerprint || !currentInput(ctx, user.id, inputId)) {
    await logEvent(ctx.db, user.id, 'route_stale', { stage: 'semantic_router' }, { at: ctx.now(), sessionId: before.active?.id })
    return reply(ctx, fresh.user, T.stale)
  }
  if (!out.ok) {
    await logEvent(ctx.db, user.id, 'llm_fallback', { stage: 'semantic_router', reason: out.reason }, { at: ctx.now(), sessionId: before.active?.id })
    if (!currentInput(ctx, user.id, inputId)) return reply(ctx, fresh.user, T.stale)
    return reply(ctx, fresh.user, T.cannotInterpret, undefined, { informational: true })
  }
  const route = out.value
  const intercepted = fresh.user.pendingInput !== 'none' && route.route !== 'answer_pending' && route.route !== 'feedback' && !(route.route === 'report' && fresh.user.pendingInput === 'report_text')
  await logEvent(ctx.db, user.id, 'semantic_routed', { route: route.route, pending: pendingType(fresh.user.pendingInput), intercepted }, { at: ctx.now(), sessionId: before.active?.id })
  const dispatchState = await snapshot(ctx, user.id)
  if (dispatchState.fingerprint !== fresh.fingerprint || !currentInput(ctx, user.id, inputId)) return reply(ctx, fresh.user, T.stale)
  if (route.route === 'unclear' && !dispatchState.report) return reply(ctx, fresh.user, 'Уточни, что ты хочешь сделать. Ничего не меняю.', undefined, { informational: true })
  await dispatch(ctx, dispatchState, route, via, contextEventId, handlePending, control)
  if (route.route === 'feedback') return
  if (route.followUp) {
    const after = await snapshot(ctx, user.id)
    if (after.user && currentInput(ctx, user.id, inputId)) {
      // Never apply the second part on this turn. Even a compound close-day is a proposal.
      let follow = route.followUp
      if (follow.route === 'new_task' && follow.intent.task !== null) {
        // Model labels belong to the pre-action snapshot. Bind the proposed
        // task by identity before task completion can reorder the projection.
        const selectedLabel = follow.intent.task
        const selectedId = dispatchState.labelledTasks.find(t => t.label === selectedLabel)?.id
        const selected = after.labelledTasks.find(t => t.id === selectedId && t.status === 'active')
        if (!selected) return reply(ctx, after.user, T.stale)
        follow = { ...follow, intent: { ...follow.intent, task: selected.label } }
      }
      const proposed: SemanticRoute = { ...follow, followUp: null }
      const id = storeChoice(ctx, after, follow.text, via, proposed)
      const caption = follow.route === 'new_task' ? `Начать «${follow.text.slice(0, 60)}»?` : follow.route === 'continue_same' ? 'Продолжить ту же задачу?' : follow.route === 'schedule_meeting' ? `Назначить встречу ${follow.day === 'tomorrow' ? 'завтра ' : ''}в ${String(follow.hour).padStart(2,'0')}:${String(follow.minute).padStart(2,'0')}${follow.closeDay ? ' и закрыть день' : ''}?` : 'Закрыть день?'
      await reply(ctx, after.user, caption, [[{ text: caption, data: cb('sroute', id, 'next') }]])
    }
  }
}
function storeChoice(ctx: Ctx, s: Snapshot, text: string, via: 'text' | 'voice', route?: SemanticRoute): string {
  invalidateSemanticChoices(s.user!.id)
  for (const [id, choice] of choices) if (ctx.now().getTime() - choice.at > TTL) choices.delete(id)
  if (choices.size >= MAX_CHOICES) choices.delete(choices.keys().next().value!)
  const id = randomUUID()
  choices.set(id, { userId: s.user!.id, at: ctx.now().getTime(), fingerprint: s.fingerprint, text, via, ...(route ? { route } : {}) })
  return id
}
async function askChoice(ctx: Ctx, s: Snapshot, text: string, via: 'text' | 'voice') {
  const id = storeChoice(ctx, s, text, via)
  const title = s.report?.intentText ?? s.active?.intentText ?? s.last?.intentText ?? 'прошлой работе'
  return reply(ctx, s.user!, 'Это отчёт о результате или новая задача?', [[
    { text: `Это отчёт о «${title.slice(0, 45)}»`, data: cb('sroute', id, 'report') },
    { text: 'Это новая задача', data: cb('sroute', id, 'new') },
  ]], { informational: true })
}
async function releaseForRoute(ctx: Ctx, s: Snapshot): Promise<User | null> {
  const user = s.user!
  if (user.pendingInput === 'none' || user.pendingInput.startsWith('session_end:')) return user
  if (['timezone', 'start_time', 'ritual'].includes(user.pendingInput)) return null
  if (user.pendingInput === 'report_text') {
    if (!await session.releaseReportPending(ctx, user, s.report?.id ?? null)) return null
  } else {
    const changed = await inputTransaction(ctx, async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${user.id}))`
      const res = await tx.user.updateMany({ where: { id: user.id, pendingInput: user.pendingInput }, data: { pendingInput: 'none' } })
      if (res.count !== 1) return false
      if (user.pendingInput.startsWith('running_task_choice:') && s.active) await tx.focusSession.updateMany({ where: { id: s.active.id, userId: user.id, state: 'running', taskId: null }, data: { pendingTaskTitle: null } })
      return true
    }, { syncReminders: false })
    if (!changed) return null
  }
  return { ...user, pendingInput: 'none' }
}
async function dispatch(...args: Parameters<typeof dispatchRoute>): Promise<void> {
  try { await dispatchRoute(...args) }
  catch (error) {
    if (error instanceof StaleTransition) return reply(args[0], args[1].user!, T.stale)
    throw error
  }
}
async function dispatchRoute(ctx: Ctx, s: Snapshot, route: SemanticRoute, via: 'text' | 'voice', contextEventId: number | null, handlePending?: PendingHandler, control?: Control) {
  if (route.route === 'feedback') return reply(ctx, s.user!, T.feedback, undefined, { informational: true })
  if (route.route === 'clarify') return reply(ctx, s.user!, route.question, undefined, { informational: true })
  if (route.route === 'control' && ['start','status','guide','help','tasks','settings','profile'].includes(route.action)) return control ? control(ctx, s.user!, route.action, route.value) : reply(ctx, s.user!, T.stale)
  if (route.route === 'answer_pending') return handlePending ? handlePending(ctx, s.user!, route.text, via, contextEventId, route.answer) : reply(ctx, s.user!, T.stale)
  if (route.route === 'unclear') return askChoice(ctx, s, route.text, via)
  let user = s.user!
  if (route.route === 'task_action' && route.action === 'number') {
    if (!await tasks.onTaskNumber(ctx, user, String(route.number))) await reply(ctx, user, T.stale)
    return
  }
  if (route.route === 'report') {
    if (!s.report || s.active) return reply(ctx, user, T.stale)
    if (user.pendingInput !== 'report_text') {
      const changed = await inputTransaction(ctx, (tx) => tx.user.updateMany({ where: { id: user.id, pendingInput: user.pendingInput }, data: { pendingInput: 'report_text' } }))
      if (changed.count !== 1) return reply(ctx, user, T.stale)
      user = { ...user, pendingInput: 'report_text' }
    }
    await session.onReportText(ctx, user, route.text, { semantic: { result: decodeReportAnswer(route.report, route.text.trim().slice(0, 1000), s.labelledTasks), tasks: s.labelledTasks, expectedSessionId: s.report.id }, suppressContinuation: route.followUp !== null })
    return
  }
  if (route.route === 'capture' && user.pendingInput === 'task_add') return tasks.onTaskAddText(ctx, user, route.text, via, route.titles)
  const released = await releaseForRoute(ctx, s)
  if (!released) return reply(ctx, user, T.stale)
  user = released
  const inputId = contextEventId
  if (!currentInput(ctx, user.id, inputId)) return reply(ctx, user, T.stale)
  const expected = JSON.parse(s.fingerprint)
  expected.user.pendingInput = user.pendingInput
  if (expected.active && s.user!.pendingInput.startsWith('running_task_choice:')) expected.active.pendingTaskTitle = null
  const guard = async (tx: Prisma.TransactionClient) => {
    if (!currentInput(ctx, user.id, inputId)) return false
    const fresh = await snapshot(ctx, user.id, tx)
    return currentInput(ctx, user.id, inputId) && fresh.fingerprint === JSON.stringify(expected)
  }
  if (route.route === 'control') {
    if (route.action === 'focus' && route.value !== null) return reply(ctx, user, T.cannotInterpret, undefined, { informational: true })
    return control ? control(ctx, user, route.action, route.value) : reply(ctx, user, T.stale)
  }
  if (route.route === 'task_action') {
    if (route.action === 'add') return tasks.onTaskAddRequested(ctx, user)
    const ref = s.labelledTasks.find(t => t.label === route.task && t.status === 'active')
    if (!ref) return reply(ctx, user, T.stale)
    if (route.action === 'open') return tasks.onTaskOpened(ctx, user, ref.id, 0)
    if (route.action === 'start') return tasks.onTaskSelected(ctx, user, ref.id)
    if (route.action === 'edit') return tasks.onTaskEditRequested(ctx, user, ref.id)
    if (route.action === 'split') return tasks.onTaskBreakdownRequested(ctx, user, ref.id)
    if (route.action === 'complete') return tasks.onTaskCompleted(ctx, user, ref.id)
    if (route.action === 'drop') return tasks.onTaskDropped(ctx, user, ref.id)
    return reply(ctx, user, T.stale)
  }
  if (route.route === 'schedule_meeting') {
    const clock = { h: route.hour, m: route.minute }
    const at = route.day === 'next' ? nextLocalTime(user.timezone, clock, ctx.now()) : localDateTime(user.timezone, addDays(dayKey(ctx.now(), user.timezone), route.day === 'tomorrow' ? 1 : 0), clock)
    if (at <= ctx.now()) return reply(ctx, user, 'Это время уже прошло. Уточни время встречи.', undefined, { informational: true })
    if (route.closeDay) return day.closeDay(ctx, user, via, { guard, meetingAt: at })
    const fresh = await ctx.db.user.findUnique({ where: { id: user.id } })
    if (!fresh || !currentInput(ctx, user.id, inputId)) return reply(ctx, user, T.stale)
    return day.scheduleMeeting(ctx, fresh, at, 'custom')
  }
  if (route.route === 'end_session') return session.onSemanticEnd(ctx, user, s.active!.id, route, guard, s.labelledTasks.find(t => t.label === route.completedTask)?.id ?? null)
  if (route.route === 'intent_step') return session.onIntentStep(ctx, user, route.title, route.minutes)
  if (route.route === 'break') return session.onBreak(ctx, user, route.minutes ?? undefined, route.durationBasis)
  if (route.route === 'new_task') {
    const ref = s.labelledTasks.find((task) => task.label === route.intent.task && task.status === 'active')
    const parsed = { taskId: ref?.id ?? null, title: route.intent.title, scope: route.intent.scope, minutes: route.minutes, llmUsed: true }
    if (s.active?.state === 'paused') await session.onNewAfterBreak(ctx, user, () => session.onIntentText(ctx, user, route.text, { ...parsed, minutes: route.minutes }))
    else if (s.active?.state === 'running' && s.active.taskId === null && parsed.taskId === null && !s.user!.pendingInput.startsWith('running_work:')) await session.onRunningTaskCandidate(ctx, user, parsed.title, parsed)
    else if (s.active?.state === 'running') await session.onRunningWorkText(ctx, user, s.active.id, route.text, parsed)
    else await session.onIntentText(ctx, user, route.text, { ...parsed, minutes: route.minutes })
  } else if (route.route === 'capture') await tasks.onCapturedTasks(ctx, user, route.titles, via, guard)
  else if (route.route === 'session_help') {
    // Outcome remains the human's choice. A semantic compound never completes a task implicitly.
    if (route.help.kind === 'complete_and_rest') await session.onDone(ctx, user)
    else await session.onRunningFreeText(ctx, user, route.text, contextEventId, { ...route.help, taskTitle: route.help.task_title, llmUsed: true })
  } else if (route.route === 'close_day') await day.closeDay(ctx, user, via, { guard })
  else if (route.route === 'continue_same') {
    const minutes = route.minutes
    if (s.active?.reminderPolicy === 1 && (s.active.state === 'running' || s.active.state === 'paused')) {
      await onReminderAction(ctx, user, null, s.active.state === 'running' ? 'continue' : 'resume', { workMinutes: minutes ?? undefined, guard })
    } else if (s.active?.state === 'running') {
      if (minutes !== null) await session.onRunningDurationText(ctx, user, s.active.id, route.text, { fromNow: true, minutes })
      else if (s.active.plannedEndAt && s.active.plannedEndAt <= ctx.now()) await session.onDeadlineChoice(ctx, user, s.active.id, 'continue')
      else await session.onSessionHelpAction(ctx, user, s.active.id, 'continue')
    } else if (s.active?.state === 'paused') {
      await session.onResume(ctx, user)
      if (minutes !== null) await session.onRunningDurationText(ctx, user, s.active.id, route.text, { fromNow: true, minutes })
    }
    else if (!s.active && s.last?.continueSuggested && s.last.restChoice === null && s.last.taskId && s.labelledTasks.some((task) => task.id === s.last!.taskId && task.status === 'active')) {
      await session.onContinueChoice(ctx, user, s.last.id, 'same', { change: () => tasks.onSessionStart(ctx, user), minutes: route.minutes ?? undefined })
    } else {
      const source = s.active?.state === 'collecting_intent' ? s.active : s.last
      const task = s.labelledTasks.find((t) => t.id === source?.taskId && t.status === 'active')
      if (!source?.intentText && !task) return reply(ctx, user, T.stale)
      await session.onIntentText(ctx, user, task?.title ?? source!.intentText!, { taskId: task?.id ?? null, title: task?.title ?? source!.intentText!, scope: source?.scope === 'multi_session' ? 'multi_session' : 'step', minutes, llmUsed: true })
    }
  }
  if (s.report && s.user!.pendingInput === 'report_text') {
    await reply(ctx, user, 'Отчёт о прошлой сессии можно заполнить позже.', [[{ text: 'Вернуться к отчёту', data: cb('report', s.report.id) }]])
  }
}
export async function onSemanticChoice(ctx: Ctx, user: User, id: string, arg: string): Promise<void> {
  const choice = choices.get(id)
  if (!choice || choice.userId !== user.id || !ctx.semanticRouterEnabled || ctx.now().getTime() - choice.at > TTL) return reply(ctx, user, T.stale)
  choices.delete(id) // claim before the first await: concurrent callbacks cannot replay
  const s = await snapshot(ctx, user.id)
  if ((ctx.isCurrentInput && !ctx.isCurrentInput()) || !s.user || s.fingerprint !== choice.fingerprint) { choices.delete(id); return reply(ctx, user, T.stale) }
  choices.delete(id)
  if (arg === 'next' && choice.route) {
    if (!allowedRoutes(s).includes(choice.route.route)) return reply(ctx, user, T.stale)
    return dispatch(ctx, s, choice.route, choice.via, null)
  }
  if (arg === 'new' && !choice.route) return reply(ctx, user, 'Напиши, какую работу хочешь начать.')
  if (arg === 'report' && !choice.route) {
    if (s.active?.state === 'running') return session.onDone(ctx, s.user)
    if (!s.report || s.active) return reply(ctx, user, T.stale)
    await onRestoreReport(ctx, s.user, s.report.id)
    const fresh = await ctx.db.user.findUniqueOrThrow({ where: { id: user.id } })
    if (ctx.isCurrentInput && !ctx.isCurrentInput()) return reply(ctx, fresh, T.stale)
    if (fresh.pendingInput === 'report_text') await session.onReportText(ctx, fresh, choice.text, { confirmedReport: true })
    return
  }
  return reply(ctx, user, T.stale)
}
export async function onRestoreReport(ctx: Ctx, user: User, sessionId: string): Promise<void> {
  const ok = await inputTransaction(ctx, async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${user.id}))`
    if ((await session.pendingReportSession(tx, user.id, ctx.now()))?.id !== sessionId || await tx.focusSession.findFirst({ where: { userId: user.id, state: { in: ['running', 'paused', 'collecting_intent'] } } })) return false
    return (await tx.user.updateMany({ where: { id: user.id, pendingInput: { in: ['none', 'report_text'] } }, data: { pendingInput: 'report_text' } })).count === 1
  })
  await reply(ctx, user, ok ? 'Что получилось в прошлой сессии? Отчёт необязателен.' : T.stale)
}
