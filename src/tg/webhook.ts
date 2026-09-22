import { z } from 'zod'
import type { User } from '@prisma/client'
import { logEvent } from '../analytics/log.js'
import { log } from '../lib/log.js'
import { parseCallback } from '../bot/callbacks.js'
import { reply, type Ctx } from '../bot/context.js'
import { T } from '../bot/texts.js'
import * as account from '../bot/account.js'
import * as day from '../bot/day-flow.js'
import * as session from '../bot/session-flow.js'
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

// Лимит апдейтов на пользователя в минуту. Человеку столько не нужно, а скрипт
// с чужого аккаунта не должен размножать сессии и события.
export const RATE_LIMIT_PER_MINUTE = 30

async function allowed(ctx: Ctx, tgId: bigint): Promise<boolean> {
  const now = ctx.now()
  const window = new Date(Math.floor(now.getTime() / 60_000) * 60_000)
  const rows = await ctx.db.$queryRaw<{ count: number }[]>`
    INSERT INTO rate_limits (tg_id, window_start, count) VALUES (${tgId}, ${window}, 1)
    ON CONFLICT (tg_id, window_start) DO UPDATE SET count = rate_limits.count + 1
    RETURNING count`
  return (rows[0]?.count ?? 0) <= RATE_LIMIT_PER_MINUTE
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
  if (!(await allowed(ctx, tgId))) {
    if (cq) await ctx.tg.answerCallback(cq.id, T.tooFast).catch(() => {})
    log.warn('rate_limited')
    return
  }

  const command = parseCommand(msg?.text)
  const { user, created } = await loadUser(ctx, tgId, command?.command === 'start' ? command.args : null)

  try {
    if (cq) await onCallback(ctx, user, cq.id, cq.data, cq.message?.message_id)
    else if (command) await onCommand(ctx, user, command.command, command.args, created)
    else if (msg?.text) await onText(ctx, user, msg.text, created)
  } catch (error) {
    // Наружу — общая фраза, подробности — во внутренний лог без текста.
    log.error('handle_failed', error)
    await reply(ctx, user, T.error)
  }
}

async function onCommand(ctx: Ctx, user: User, command: string, args: string, created: boolean): Promise<void> {
  const now = ctx.now()
  if (command === 'start') {
    await logEvent(ctx.db, user.id, 'bot_started', { source: user.source, returning: !created }, { at: now })
    if (!user.consentAt) return account.sendConsent(ctx, user)
    return session.askIntent(ctx, user, { prefix: T.welcomeBack })
  }
  if (command === 'delete_me') return account.askDelete(ctx, user)
  if (!user.consentAt) {
    if (created) return account.sendConsent(ctx, user)
    return reply(ctx, user, T.consentRequired)
  }
  switch (command) {
    case 'focus':
      if (args) return session.onIntentText(ctx, user, args)
      return session.askIntent(ctx, user)
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
    case 'settings':
      return account.sendSettings(ctx, user)
    case 'profile':
      return account.sendProfile(ctx, user)
    default:
      return reply(ctx, user, T.help)
  }
}

async function onText(ctx: Ctx, user: User, text: string, created: boolean): Promise<void> {
  if (!user.consentAt) {
    // До согласия текст не обрабатывается и не сохраняется.
    if (created) return account.sendConsent(ctx, user)
    return reply(ctx, user, T.consentRequired)
  }
  switch (user.pendingInput) {
    case 'timezone':
      return account.onTimezoneText(ctx, user, text)
    case 'ritual':
      return account.onRitualText(ctx, user, text)
    case 'meeting_time':
      return day.onMeetingTimeText(ctx, user, text)
    case 'morning_time':
      return account.onMorningText(ctx, user, text)
    case 'profile':
      return account.onProfileText(ctx, user, text)
    case 'report_text':
      if (await session.onReportText(ctx, user, text)) return
      break
  }
  return session.onIntentText(ctx, user, text)
}

async function onCallback(ctx: Ctx, user: User, callbackId: string, data: string | undefined, messageId: number | undefined): Promise<void> {
  // Сразу гасим «часики» на кнопке и убираем клавиатуру: повторное нажатие на
  // старую кнопку — частый источник дублей.
  await ctx.tg.answerCallback(callbackId).catch((error: unknown) => log.error('answer_callback_failed', error))
  if (messageId !== undefined) await ctx.tg.clearKeyboard(user.tgId, messageId).catch(() => {})

  const parsed = parseCallback(data)
  if (!parsed) return reply(ctx, user, T.stale)
  const { action, id, arg } = parsed

  if (action === 'del' && arg === 'confirm') return account.onDeleteConfirm(ctx, user)
  if (action === 'consent') return account.onConsent(ctx, user)
  if (!user.consentAt) return reply(ctx, user, T.consentRequired)

  try {
    switch (action) {
      case 'len':
        if (id && arg) return await session.onLength(ctx, user, id, arg)
        break
      case 'ping':
        if (id && arg) return await session.onPing(ctx, user, id, arg)
        break
      case 'out':
        if (id && arg && (OUTCOMES as readonly string[]).includes(arg)) return await session.onOutcome(ctx, user, id, arg as Outcome)
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
        if (arg === 'ritual') return await account.onRitualText(ctx, user, null)
        break
    }
  } catch (error) {
    if (error instanceof StaleTransition) return reply(ctx, user, T.stale)
    throw error
  }
  return reply(ctx, user, T.stale)
}
