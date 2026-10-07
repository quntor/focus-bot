import type { PendingAnswer } from '../llm/router.js'
import { localDateTime, nextLocalTime } from '../lib/time.js'
import { addDays, dayKey } from '../lib/day.js'
import { onReminderAction, onRetro } from '../reminders/actions.js'
import { beginInput, withUserInputLock, currentInputTransaction, assertCurrentInput } from '../bot/input-lock.js'
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
import { showStatus } from '../bot/status.js'
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
  ctx = { ...ctx, semanticRouterEnabled: true }
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
  const command = parseCommand(msg?.text)
  ctx = { ...ctx, isCurrentInput: beginInput(String(tgId)) }
  const count = await countInWindow(ctx, tgId)
  if (count > RATE_LIMIT_PER_MINUTE) {
    // Молчание выглядит как сломанный бот. Но отвечать на каждое сообщение
    // сверх лимита — снова размножать отправки: пишем один раз за окно.
    if (cq) await ctx.tg.answerCallback(cq.id, T.tooFast).catch(() => {})
    else if (count === RATE_LIMIT_PER_MINUTE + 1) await ctx.tg.send(tgId, T.tooFast).catch(() => {})
    log.warn('rate_limited')
    return
  }

  let { user, created } = await loadUser(ctx, tgId, command?.command === 'start' ? command.args : null)
  ctx = { ...ctx, inputUserId: user.id, inputUserCreated: created }
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
      else if (msg?.voice) {
        {
          const text = await tasks.transcribeVoice(ctx, user, msg.voice)
          if (!text) return
          const voiceContextEventId = rememberConversationContext(user.id, 'user', text, ctx.now())
          await routeInput(ctx, user, text, 'voice', voiceContextEventId)
        }
      }
      else if (msg?.text) await routeInput(ctx, user, msg.text, 'text', contextEventId)
      // Фото, стикер, кружок, файл: разобрать не можем, но и молчать нельзя.
      else if (msg) {
        if (created) await account.beginOnboarding(ctx, user)
        else await reply(ctx, user, T.unsupported)
      }
    } catch (error) {
      if (ctx.semanticRouterEnabled && error instanceof StaleTransition) return
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
    if (['timezone', 'start_time', 'ritual'].includes(user.pendingInput)) return account.resumeOnboarding(ctx, user)
    if (created || await ctx.db.focusSession.count({ where: { userId: user.id } }) === 0) return account.beginOnboarding(ctx, user)
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

// Бот ждёт не больше одного ответа (pendingInput). Команда или кнопка
// клавиатуры — другое действие: ожидание снимается, иначе следующая фраза
// человека ушла бы в старый вопрос (профиль, отчёт, время встречи). Знакомство
// не снимается: /help посреди него не должен его обрывать. Ожидание выбора на
// «Время вышло» привязано к сессии и живёт вместе с ней.
const ONBOARDING_INPUTS = ['timezone', 'start_time', 'ritual']

export async function releasePending(ctx: Ctx, user: User, fenced = false): Promise<User> {
  if (user.pendingInput === 'none' || ONBOARDING_INPUTS.includes(user.pendingInput) || user.pendingInput.startsWith('session_end:')) return user
  if (fenced) assertCurrentInput(ctx)
  const runningTaskChoice = /^running_task_choice:([0-9a-f-]{36}):([0-9a-f]{8})(?::[A-Za-z0-9_-]+)?$/.exec(user.pendingInput)
  const release = async (tx: import('@prisma/client').Prisma.TransactionClient) => {
    if (runningTaskChoice?.[1]) {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${user.id}))`
      const released = await tx.user.updateMany({where:{id:user.id,pendingInput:user.pendingInput},data:{pendingInput:'none'}})
      if (released.count !== 1) return
      await tx.focusSession.updateMany({where:{id:runningTaskChoice[1],userId:user.id,state:'running',taskId:null},data:{pendingTaskTitle:null}})
    } else {
      await tx.user.updateMany({where:{id:user.id,pendingInput:user.pendingInput},data:{pendingInput:'none'}})
    }
  }
  if (fenced) await currentInputTransaction(ctx, release)
  else if (runningTaskChoice?.[1]) await ctx.db.$transaction(release)
  else await ctx.db.user.updateMany({where:{id:user.id,pendingInput:user.pendingInput},data:{pendingInput:'none'}})
  return { ...user, pendingInput: 'none' }
}

// Every textual input, including reply-keyboard and slash commands, is interpreted by the LLM.
async function routeInput(ctx: Ctx, user: User, text: string, via: 'text' | 'voice', contextEventId: number | null): Promise<void> {
  assertCurrentInput(ctx)
  return routeSemanticInput(ctx, user, text, via, contextEventId, routePendingInput, onSemanticControl)
}
async function onSemanticControl(ctx: Ctx, user: User, action: string, value: string | null): Promise<void> {
  if (action === 'status') return showStatus(ctx, user)
  if (action === 'tasks') return tasks.showTasks(ctx, user)
  if (action === 'settings') return account.sendSettings(ctx, user)
  if (action === 'profile') return account.sendProfile(ctx, user)
  if (action === 'guide') return reply(ctx, user, T.guide, undefined, { informational: true })
  if (action === 'help') return reply(ctx, user, T.help, undefined, { informational: true })
  if (action === 'new_session') return session.onNewAfterBreak(ctx, user, () => tasks.onSessionStart(ctx, user))
  return onCommand(ctx, user, action, value ?? '', ctx.inputUserCreated ?? false)
}

async function routePendingInput(ctx: Ctx, user: User, text: string, via: 'text' | 'voice', contextEventId: number | null, answer?: PendingAnswer): Promise<void> {
  const pending = user.pendingInput
  const reject = () => reply(ctx, user, T.cannotInterpret, undefined, { informational: true })
  if (!answer) return reject()
  if (answer.kind === 'clock') {
    const value = `${String(answer.hour).padStart(2, '0')}:${String(answer.minute).padStart(2, '0')}`
    if (pending === 'timezone' || pending === 'settings_timezone') return account.onTimezoneText(ctx, user, value)
    if (pending === 'start_time') return account.onStartTimeText(ctx, user, value)
    if (pending === 'morning_time') return account.onMorningText(ctx, user, value)
    if (pending === 'meeting_time' || pending === 'meeting_time_soft') {
      const clock = { h: answer.hour, m: answer.minute }
      const at = answer.day === 'next' ? nextLocalTime(user.timezone, clock, ctx.now()) : localDateTime(user.timezone, addDays(dayKey(ctx.now(), user.timezone), answer.day === 'tomorrow' ? 1 : 0), clock)
      if (at <= ctx.now()) return reject()
      return day.scheduleMeeting(ctx, user, at, 'custom')
    }
  } else if (answer.kind === 'text') {
    if (pending === 'ritual' || pending === 'profile_ritual') return account.onRitualText(ctx, user, answer.value)
    if (pending === 'profile') return account.onProfileText(ctx, user, answer.value)
    const split = TASK_SPLIT.exec(pending)
    if (split?.[1] && !pending.startsWith('task_split_manual:')) return tasks.onTaskBreakdownAnswer(ctx, user, split[1], answer.value, via, contextEventId)
    const edit = /^task_edit:([0-9a-f-]{36})$/.exec(pending)
    if (edit?.[1]) return tasks.onTaskEditText(ctx, user, edit[1], answer.value)
  } else if (answer.kind === 'duration') {
    const edit = /^running_duration:([0-9a-f-]{36})$/.exec(pending)
    if (edit?.[1]) return session.onRunningDurationText(ctx, user, edit[1], '', { minutes: answer.minutes })
  } else if (answer.kind === 'retro') {
    if (pending.startsWith('retro:')) return onRetro(ctx, user, pending.split(':')[1]!, `m${answer.minutesAgo}`)
  } else if (answer.kind === 'choice') {
    if (answer.value === 'skip' && pending === 'start_time') return account.onOnboardingButton(ctx, user, 'st_skip')
    if (answer.value === 'skip' && (pending === 'ritual' || pending === 'profile_ritual')) return account.onRitualText(ctx, user, null)
    const choice = /^running_task_choice:([0-9a-f-]{36}):([0-9a-f]{8})(?::[A-Za-z0-9_-]+)?$/.exec(pending)
    if (choice?.[1] && choice[2] && answer.value !== 'skip') return session.onRunningTaskChoice(ctx, user, choice[1], answer.value, { existing: () => tasks.showTaskPicker(ctx, user, T.tasksPick) }, choice[2])
  } else if (answer.kind === 'steps') {
    const split = TASK_SPLIT.exec(pending)
    if (split?.[1]) return tasks.onTaskBreakdownAnswer(ctx, user, split[1], text, via, contextEventId, answer.titles)
  }
  return reject()
}

async function onCallback(ctx: Ctx, user: User, callbackId: string, data: string | undefined, messageId: number | undefined): Promise<void> {
  // Сразу гасим «часики» на кнопке и убираем клавиатуру: повторное нажатие на
  // старую кнопку — частый источник дублей.
  await ctx.tg.answerCallback(callbackId).catch((error: unknown) => log.error('answer_callback_failed', error))
  if (messageId !== undefined) await ctx.tg.clearKeyboard(user.tgId, messageId).catch(() => {})

  const parsed = parseCallback(data)
  if (!parsed) return reply(ctx, user, T.stale)
  const { action, id, arg } = parsed

  if (action === 'sroute' && id && arg) return onSemanticChoice(ctx, user, id, arg)
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
      case 'cycle':
      case 'morning':
        if (arg) return await onReminderAction(ctx,user,id,arg)
        break
      case 'retro':
        if (id && arg) return await onRetro(ctx,user,id,arg)
        break
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
        const choice = /^(new|list|cancel)_([0-9a-f]{8})(?::[A-Za-z0-9_-]+)?$/.exec(arg ?? '')
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
      case 'taskundo':
        if (id && !arg) return await tasks.onTaskUndo(ctx, user, id)
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
