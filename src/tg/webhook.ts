import { beginInput, withUserInputLock } from '../bot/input-lock.js'
import { routeSemanticInput, onSemanticChoice, onRestoreReport, invalidateSemanticChoices } from '../bot/semantic-routing.js'
import { z } from 'zod'
import type { User } from '@prisma/client'
import { logEvent } from '../analytics/log.js'
import { log } from '../lib/log.js'
import { parseCallback } from '../bot/callbacks.js'
import { reply, type Ctx } from '../bot/context.js'
import { rememberConversationContext } from '../bot/conversation-context.js'
import { T } from '../bot/texts.js'
import * as account from '../bot/account.js'
import * as day from '../bot/day-flow.js'
import * as session from '../bot/session-flow.js'
import * as tasks from '../bot/tasks.js'
import { OUTCOMES, StaleTransition, type Outcome } from '../session/fsm.js'
import { parseCommand, parseSource } from './commands.js'
import { claimUpdate } from './dedupe.js'

// Разбираем только то, что читаем. Остальные поля апдейта Telegram меняет чаще,
// чем выходят его же релизы, и строгая схема на всё сообщение ломала бы бота
// на ровном месте.
const from = z.object({ id: z.number(), is_bot: z.boolean().optional() })
const updateSchema = z.object({
  update_id: z.number(),
  message: z
    .object({
      text: z.string().optional(),
      voice: z
        .object({
          file_id: z.string().min(1),
          duration: z.number().int().nonnegative(),
          mime_type: z.string().optional(),
          file_size: z.number().int().nonnegative().optional(),
        })
        .optional(),
      from: from.optional(),
      chat: z.object({ id: z.number(), type: z.string() }),
    })
    .optional(),
  callback_query: z
    .object({
      id: z.string(),
      from,
      data: z.string().optional(),
      message: z.object({ message_id: z.number(), chat: z.object({ id: z.number(), type: z.string() }) }).optional(),
    })
    .optional(),
})

export type Update = z.infer<typeof updateSchema>

// Ждём ответа на «Разобрать»: task_split | task_split_clarify | task_split_manual, :<taskId>.
const TASK_SPLIT = /^task_split(?:_clarify|_manual)?:([0-9a-f-]{36})$/

// Лимит апдейтов на пользователя в минуту. Человеку столько не нужно, а скрипт
// с чужого аккаунта не должен размножать сессии и события.
export const RATE_LIMIT_PER_MINUTE = 30

// Номер апдейта пользователя в текущем минутном окне.
async function countInWindow(ctx: Ctx, tgId: bigint): Promise<number> {
  const now = ctx.now()
  const window = new Date(Math.floor(now.getTime() / 60_000) * 60_000)
  const rows = await ctx.db.$queryRaw<{ count: number }[]>`
    INSERT INTO rate_limits (tg_id, window_start, count) VALUES (${tgId}, ${window}, 1)
    ON CONFLICT (tg_id, window_start) DO UPDATE SET count = rate_limits.count + 1
    RETURNING count`
  return rows[0]?.count ?? 0
}

// Владелец данных — только from.id проверенного апдейта. Ни текст сообщения, ни
// callback_data, ни deep link не определяют, чьи данные читаются и меняются.
async function loadUser(ctx: Ctx, tgId: bigint, startArgs: string | null): Promise<{ user: User; created: boolean }> {
  const existing = await ctx.db.user.findUnique({ where: { tgId } })
  if (existing) {
    // Написал — значит разблокировал. Снимаем пометку, иначе очередь молчала бы.
    if (existing.blockedAt) return { user: await ctx.db.user.update({ where: { id: existing.id }, data: { blockedAt: null } }), created: false }
    return { user: existing, created: false }
  }
  try {
    // Метка источника ставится один раз, при создании. Повторный /start по чужой
    // ссылке не должен переписывать когорту.
    const user = await ctx.db.user.create({
      data: { tgId, source: startArgs === null ? null : parseSource(startArgs), createdAt: ctx.now() },
    })
    return { user, created: true }
  } catch {
    // Гонка двух первых апдейтов: второй найдёт созданного первым.
    return { user: await ctx.db.user.findUniqueOrThrow({ where: { tgId } }), created: false }
  }
}

export async function handleUpdate(ctx: Ctx, raw: unknown): Promise<void> {
  const parsed = updateSchema.safeParse(raw)
  if (!parsed.success) return
  const update = parsed.data
  if (!(await claimUpdate(ctx.db, update.update_id))) return

  const cq = update.callback_query
  const msg = update.message
  const sender = cq?.from ?? msg?.from
  if (!sender || sender.is_bot) return
  // Только личный чат. В группе сообщение увидели бы посторонние.
  const chatType = cq?.message?.chat.type ?? msg?.chat.type
  if (chatType !== undefined && chatType !== 'private') return

  const tgId = BigInt(sender.id)
  if (ctx.semanticRouterEnabled) ctx = { ...ctx, isCurrentInput: beginInput(String(tgId)) }
  const count = await countInWindow(ctx, tgId)
  if (count > RATE_LIMIT_PER_MINUTE) {
    // Молчание выглядит как сломанный бот. Но отвечать на каждое сообщение
    // сверх лимита — снова размножать отправки: пишем один раз за окно.
    if (cq) await ctx.tg.answerCallback(cq.id, T.tooFast).catch(() => {})
    else if (count === RATE_LIMIT_PER_MINUTE + 1) await ctx.tg.send(tgId, T.tooFast).catch(() => {})
    log.warn('rate_limited')
    return
  }

  const command = parseCommand(msg?.text)
  // Инструкция доступна даже до /start и не должна сбрасывать ожидаемый ввод:
  // это справка, а не новое действие внутри пользовательского сценария.
  if (command?.command === 'guide') {
    const guideUser = await ctx.db.user.findUnique({ where: { tgId }, select: { id: true } })
    if (guideUser) invalidateSemanticChoices(guideUser.id)
    await ctx.db.user.updateMany({ where: { tgId, blockedAt: { not: null } }, data: { blockedAt: null } })
    await ctx.tg.send(tgId, T.guide)
    return
  }
  let { user, created } = await loadUser(ctx, tgId, command?.command === 'start' ? command.args : null)
  const callback = cq ? parseCallback(cq.data) : null
  if (callback?.action !== 'sroute') invalidateSemanticChoices(user.id)
  const contextEventId = msg?.voice ? rememberConversationContext(user.id, 'user', '[voice]', ctx.now()) : msg?.text
    ? rememberConversationContext(user.id, 'user', msg.text, ctx.now())
    : callback
      ? rememberConversationContext(user.id, 'button', `${callback.action}${callback.arg ? `:${callback.arg}` : ''}`, ctx.now())
      : null

  const run = async () => {
    if (ctx.isCurrentInput && !ctx.isCurrentInput()) return
    if (ctx.semanticRouterEnabled) {
      const fresh = await ctx.db.user.findUnique({ where: { id: user.id } })
      if (!fresh || (ctx.isCurrentInput && !ctx.isCurrentInput())) return
      user = fresh
    }
    try {
      if (cq) await onCallback(ctx, user, cq.id, cq.data, cq.message?.message_id)
      else if (command) await onCommand(ctx, user, command.command, command.args, created)
      else if (msg?.voice) {
        if (created) await account.beginOnboarding(ctx, user)
        else {
          const text = await tasks.transcribeVoice(ctx, user, msg.voice)
          if (!text) return
          const voiceContextEventId = rememberConversationContext(user.id, 'user', text, ctx.now())
          await routeInput(ctx, user, text, 'voice', voiceContextEventId)
        }
      }
      else if (msg?.text) await onText(ctx, user, msg.text, created, contextEventId)
      // Фото, стикер, кружок, файл: разобрать не можем, но и молчать нельзя.
      else if (msg) {
        if (created) await account.beginOnboarding(ctx, user)
        else await reply(ctx, user, T.unsupported)
      }
    } catch (error) {
      // Наружу — общая фраза, подробности — во внутренний лог без текста.
      log.error('handle_failed', error)
      await reply(ctx, user, T.error)
    }
  }
  if (ctx.semanticRouterEnabled) await withUserInputLock(user.id, run)
  else await run()
}

async function onCommand(ctx: Ctx, user: User, command: string, args: string, created: boolean): Promise<void> {
  invalidateSemanticChoices(user.id)
  const now = ctx.now()
  if (!(command === 'start' && ONBOARDING_INPUTS.includes(user.pendingInput))) user = await releasePending(ctx, user)
  if (command === 'start') {
    await logEvent(ctx.db, user.id, 'bot_started', { source: user.source, returning: !created }, { at: now })
    if (created) return account.beginOnboarding(ctx, user)
    if (['timezone', 'start_time', 'ritual'].includes(user.pendingInput)) return account.resumeOnboarding(ctx, user)
    return session.askIntent(ctx, user, { prefix: T.welcomeBack })
  }
  if (command === 'delete_me') return account.askDelete(ctx, user)
  if (created) return account.beginOnboarding(ctx, user)
  switch (command) {
    case 'focus':
      if (args) return session.onIntentText(ctx, user, args)
      return tasks.onSessionStart(ctx, user)
    case 'tasks':
      return tasks.showTasks(ctx, user)
    case 'done':
      return session.onDone(ctx, user)
    case 'stop':
      return session.onStop(ctx, user)
    case 'today':
      return day.closeDay(ctx, user, 'command')
    case 'goal': {
      const n = Number(args)
      if (Number.isInteger(n) && n >= 1 && n <= 20) return day.onGoal(ctx, user, String(n))
      return reply(ctx, user, T.askGoal, day.goalKeyboard())
    }
    case 'dayoff':
      return day.planDayOff(ctx, user)
    case 'settings':
      return account.sendSettings(ctx, user)
    case 'profile':
      return account.sendProfile(ctx, user)
    default:
      return reply(ctx, user, T.help)
  }
}

async function onText(ctx: Ctx, user: User, text: string, created: boolean, contextEventId: number | null): Promise<void> {
  if (created) return account.beginOnboarding(ctx, user)
  const button = KEYBOARD_ACTIONS[text]
  if (button) { invalidateSemanticChoices(user.id); return button(ctx, await releasePending(ctx, user)) }
  await routeInput(ctx, user, text, 'text', contextEventId)
}

// Кнопки постоянной клавиатуры — это новое действие, а не ответ на вопрос бота.
const KEYBOARD_ACTIONS: Record<string, (ctx: Ctx, user: User) => Promise<void>> = {
  [T.sessionStartButton]: (ctx, user) => tasks.onSessionStart(ctx, user),
  [T.tasksButton]: (ctx, user) => tasks.showTasks(ctx, user),
  [T.sessionBreakButton]: (ctx, user) => session.onBreak(ctx, user),
  [T.sessionResumeButton]: (ctx, user) => session.onResume(ctx, user),
  [T.sessionNewButton]: (ctx, user) => session.onNewAfterBreak(ctx, user, () => tasks.onSessionStart(ctx, user)),
}

// Бот ждёт не больше одного ответа (pendingInput). Команда или кнопка
// клавиатуры — другое действие: ожидание снимается, иначе следующая фраза
// человека ушла бы в старый вопрос (профиль, отчёт, время встречи). Знакомство
// не снимается: /help посреди него не должен его обрывать. Ожидание выбора на
// «Время вышло» привязано к сессии и живёт вместе с ней.
const ONBOARDING_INPUTS = ['timezone', 'start_time', 'ritual']

export async function releasePending(ctx: Ctx, user: User): Promise<User> {
  if (user.pendingInput === 'none' || ONBOARDING_INPUTS.includes(user.pendingInput) || user.pendingInput.startsWith('session_end:')) return user
  const runningTaskChoice = /^running_task_choice:([0-9a-f-]{36}):([0-9a-f]{8})$/.exec(user.pendingInput)
  if (runningTaskChoice?.[1]) {
    await ctx.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${user.id}))`
      const released = await tx.user.updateMany({
        where: { id: user.id, pendingInput: user.pendingInput },
        data: { pendingInput: 'none' },
      })
      if (released.count !== 1) return
      await tx.focusSession.updateMany({
        where: { id: runningTaskChoice[1], userId: user.id, state: 'running', taskId: null },
        data: { pendingTaskTitle: null },
      })
    })
  } else {
    await ctx.db.user.updateMany({ where: { id: user.id, pendingInput: user.pendingInput }, data: { pendingInput: 'none' } })
  }
  return { ...user, pendingInput: 'none' }
}

// Commands/buttons are deterministic; free text/voice goes through the same router.
async function routeInput(ctx: Ctx, user: User, text: string, via: 'text' | 'voice', contextEventId: number | null): Promise<void> {
  return routeSemanticInput(ctx, user, text, via, contextEventId, routeLegacyInput, routePendingInput)
}
async function routePendingInput(ctx: Ctx, user: User, text: string, via: 'text' | 'voice', contextEventId: number | null): Promise<void> {
  const pending = user.pendingInput
  const runningTaskChoice = /^running_task_choice:([0-9a-f-]{36}):([0-9a-f]{8})$/.exec(pending)
  if (runningTaskChoice?.[1]) {
    return session.onRunningTaskChoiceText(ctx, user, runningTaskChoice[1], text, {
      existing: () => tasks.showTaskPicker(ctx, user, T.tasksPick),
    })
  }
  const runningEdit = /^running_(work|duration):([0-9a-f-]{36})$/.exec(pending)
  if (runningEdit?.[1] === 'work' && runningEdit[2]) return session.onRunningWorkText(ctx, user, runningEdit[2], text)
  if (runningEdit?.[1] === 'duration' && runningEdit[2]) return session.onRunningDurationText(ctx, user, runningEdit[2], text)
  const taskEdit = /^task_edit:([0-9a-f-]{36})$/.exec(pending)
  if (taskEdit?.[1]) return tasks.onTaskEditText(ctx, user, taskEdit[1], text)
  const taskSplit = TASK_SPLIT.exec(pending)
  if (taskSplit?.[1]) return tasks.onTaskBreakdownAnswer(ctx, user, taskSplit[1], text, via, contextEventId)
  switch (pending) {
    case 'task_add':
      return tasks.onTaskAddText(ctx, user, text, via)
    case 'timezone':
    case 'settings_timezone':
      return account.onTimezoneText(ctx, user, text)
    case 'start_time':
      return account.onStartTimeText(ctx, user, text)
    case 'ritual':
    case 'profile_ritual':
      return account.onRitualText(ctx, user, text)
    case 'meeting_time':
    case 'meeting_time_soft':
      if (await day.onMeetingTimeText(ctx, user, text, { soft: pending === 'meeting_time_soft' })) return
      return reply(ctx, user, T.stale)
    case 'morning_time':
      return account.onMorningText(ctx, user, text)
    case 'profile':
      return account.onProfileText(ctx, user, text)
  }
  return reply(ctx, user, T.stale)
}

async function routeLegacyInput(ctx: Ctx, user: User, text: string, via: 'text' | 'voice', contextEventId: number | null): Promise<void> {
  const pending = user.pendingInput
  const runningTaskChoice = /^running_task_choice:([0-9a-f-]{36}):([0-9a-f]{8})$/.exec(pending)
  if (runningTaskChoice?.[1]) {
    return session.onRunningTaskChoiceText(ctx, user, runningTaskChoice[1], text, {
      existing: () => tasks.showTaskPicker(ctx, user, T.tasksPick),
    })
  }
  const runningEdit = /^running_(work|duration):([0-9a-f-]{36})$/.exec(pending)
  if (runningEdit?.[1] === 'work' && runningEdit[2]) return session.onRunningWorkText(ctx, user, runningEdit[2], text)
  if (runningEdit?.[1] === 'duration' && runningEdit[2]) return session.onRunningDurationText(ctx, user, runningEdit[2], text)
  const taskEdit = /^task_edit:([0-9a-f-]{36})$/.exec(pending)
  if (taskEdit?.[1]) return tasks.onTaskEditText(ctx, user, taskEdit[1], text)
  const taskSplit = TASK_SPLIT.exec(pending)
  if (taskSplit?.[1]) return tasks.onTaskBreakdownAnswer(ctx, user, taskSplit[1], text, via, contextEventId)
  switch (pending) {
    case 'task_add':
      return tasks.onTaskAddText(ctx, user, text, via)
    case 'timezone':
    case 'settings_timezone':
      return account.onTimezoneText(ctx, user, text)
    case 'start_time':
      return account.onStartTimeText(ctx, user, text)
    case 'ritual':
    case 'profile_ritual':
      return account.onRitualText(ctx, user, text)
    case 'meeting_time':
    case 'meeting_time_soft':
      if (await day.onMeetingTimeText(ctx, user, text, { soft: pending === 'meeting_time_soft' })) return
      user = { ...user, pendingInput: 'none' }
      break
    case 'morning_time':
      return account.onMorningText(ctx, user, text)
    case 'profile':
      return account.onProfileText(ctx, user, text)
    case 'report_text':
      const reportRoute = await onPendingReport(ctx, user, text, via)
      if (reportRoute.kind !== 'new_action') return
      // Новое действие снимает только ещё актуальное ожидание старого отчёта.
      const released = await session.releaseReportPending(ctx, user, reportRoute.sessionId)
      if (!released) return reply(ctx, user, T.stale)
      user = { ...user, pendingInput: 'none' }
      break
  }
  if (await session.onRunningFreeText(ctx, user, text, contextEventId)) return
  const outcome = await tasks.onTaskMessage(ctx, user, text, via, contextEventId)
  if (outcome === 'session_intent') {
    const current = await session.activeSession(ctx, user.id)
    if (current?.state === 'running' && current.taskId === null) return session.onRunningTaskCandidate(ctx, user, text)
    return session.onIntentText(ctx, user, text)
  }
  if (outcome === 'close_day') return day.closeDay(ctx, user, via)
}

async function onPendingReport(ctx: Ctx, user: User, text: string, via: 'text' | 'voice') {
  const meetingAt = day.explicitMeetingAt(text, user, ctx.now())
  const result = await session.onReportText(ctx, user, text, { endDay: meetingAt !== null })
  if (result.kind === 'saved' && meetingAt) await day.closeDay(ctx, user, via, { meetingAt })
  return result
}

async function onCallback(ctx: Ctx, user: User, callbackId: string, data: string | undefined, messageId: number | undefined): Promise<void> {
  // Сразу гасим «часики» на кнопке и убираем клавиатуру: повторное нажатие на
  // старую кнопку — частый источник дублей.
  await ctx.tg.answerCallback(callbackId).catch((error: unknown) => log.error('answer_callback_failed', error))
  if (messageId !== undefined) await ctx.tg.clearKeyboard(user.tgId, messageId).catch(() => {})

  const parsed = parseCallback(data)
  if (!parsed) return reply(ctx, user, T.stale)
  const { action, id, arg } = parsed

  if (action === 'sroute' && id && arg) return onSemanticChoice(ctx, user, id, arg, routeLegacyInput)
  invalidateSemanticChoices(user.id)
  if (action === 'report') return id && !arg ? onRestoreReport(ctx, user, id) : reply(ctx, user, T.stale)

  if (action === 'del' && arg === 'confirm') return account.onDeleteConfirm(ctx, user)
  // Старая кнопка согласия продолжает только незаконченное знакомство: у
  // прошедшего его она иначе начинала бы всё заново.
  if (action === 'consent') {
    if (ONBOARDING_INPUTS.includes(user.pendingInput)) return account.resumeOnboarding(ctx, user)
    if (await account.isOnboarding(ctx, user.id)) return account.beginOnboarding(ctx, user)
    return reply(ctx, user, T.stale)
  }

  try {
    switch (action) {
      case 'len':
        if (id && arg) return await session.onLength(ctx, user, id, arg)
        break
      case 'run':
        if (id && (arg === 'work' || arg === 'duration')) return await session.onRunningEdit(ctx, user, id, arg)
        break
      case 'help':
        if (id && (arg === 'continue' || arg === 'step' || arg === 'finish')) return await session.onSessionHelpAction(ctx, user, id, arg)
        break
      case 'rtask': {
        const choice = /^(new|list|cancel)_([0-9a-f]{8})$/.exec(arg ?? '')
        if (id && choice) {
          return await session.onRunningTaskChoice(ctx, user, id, choice[1] === 'list' ? 'existing' : choice[1] as 'new' | 'cancel', {
            existing: () => tasks.showTaskPicker(ctx, user, T.tasksPick),
          }, choice[2]!)
        }
        return await reply(ctx, user, T.stale)
      }
      case 'ping':
        if (id && arg) return await session.onPing(ctx, user, id, arg)
        break
      case 'out':
        if (id && arg && (OUTCOMES as readonly string[]).includes(arg)) return await session.onOutcome(ctx, user, id, arg as Outcome)
        break
      case 'end':
        if (id && (arg === 'continue' || arg === 'break')) return await session.onDeadlineChoice(ctx, user, id, arg)
        break
      case 'skiprep':
        if (id) return await session.onSkipReport(ctx, user, id)
        break
      case 'rest':
        if (id && (arg === 'rest' || arg === 'continue' || arg === 'later' || arg === 'day_end')) {
          return await session.onRest(ctx, user, id, arg, {
            later: () => day.askLater(ctx, user),
            dayEnd: () => day.closeDay(ctx, user, 'button'),
          })
        }
        break
      case 'again':
        if (id && (arg === 'same' || arg === 'step' || arg === 'change')) {
          return await session.onContinueChoice(ctx, user, id, arg, {
            change: () => tasks.showTaskPicker(ctx, user, T.tasksPick),
          })
        }
        break
      case 'meet':
        if (arg) return await day.onMeet(ctx, user, arg)
        break
      case 'mtg':
        if (arg === 'postpone') return await day.onPostpone(ctx, user)
        if (arg === 'day_end') return await day.closeDay(ctx, user, 'button')
        break
      case 'dec':
        if (arg) return await day.onDecline(ctx, user, arg)
        break
      case 'goal':
        if (arg) return await day.onGoal(ctx, user, arg)
        break
      case 'quick':
        if (arg === 'start') return await session.startUnassigned(ctx, user)
        if (arg === 'goal') return await reply(ctx, user, T.askGoal, day.goalKeyboard())
        break
      case 'sum':
        if (arg) return await day.onSummaryConfirm(ctx, user, arg)
        break
      case 'set':
        if (arg) return await account.onSetting(ctx, user, arg)
        break
      case 'tech':
        if (arg) return await account.onTechnique(ctx, user, arg)
        break
      case 'prof':
        if (arg) return await account.onProfileAction(ctx, user, arg)
        break
      case 'skip':
        // Старая кнопка знакомства срабатывает только на шаге ритуала.
        if (arg === 'ritual' && user.pendingInput === 'ritual') return await account.onRitualText(ctx, user, null)
        break
      case 'onb':
        if (arg) return await account.onOnboardingButton(ctx, user, arg)
        break
      case 'off':
        if (arg === 'tomorrow') return await day.planDayOff(ctx, user)
        break
      case 'task':
        if (id && arg?.startsWith('view')) {
          const page = /^view(\d{1,4})$/.exec(arg)
          if (page) return await tasks.onTaskOpened(ctx, user, id, Number(page[1]))
        }
        if (id && arg === 'start') return await tasks.onTaskSelected(ctx, user, id)
        if (id && arg === 'done') return await tasks.onTaskCompleted(ctx, user, id)
        if (id && arg === 'edit') return await tasks.onTaskEditRequested(ctx, user, id)
        if (id && arg === 'drop') return await tasks.onTaskDropped(ctx, user, id)
        if (id && arg === 'restore') return await tasks.onTaskRestored(ctx, user, id)
        if (id && arg === 'split') return await tasks.onTaskBreakdownRequested(ctx, user, id)
        if (id && arg === 'splitauto') return await tasks.onTaskBreakdownAnswer(ctx, user, id, null, 'text')
        break
      case 'tasks':
        if (arg === 'add') return await tasks.onTaskAddRequested(ctx, user)
        if (arg) return await tasks.onTasksPage(ctx, user, arg)
        break
    }
  } catch (error) {
    if (error instanceof StaleTransition) return reply(ctx, user, T.stale)
    throw error
  }
  return reply(ctx, user, T.stale)
}
