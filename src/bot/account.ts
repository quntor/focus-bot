import type { User } from '@prisma/client'
import { logEvent } from '../analytics/log.js'
import { parseClock, zoneFromLocalClock, offsetMinutes } from '../lib/time.js'
import { cancelPending } from '../outbox/queue.js'
import { isTechnique } from '../session/technique.js'
import { cb } from './callbacks.js'
import { reply, type Ctx } from './context.js'
import { resetConversationContext } from './conversation-context.js'
import { ensureNextMeeting, rescheduleMorning } from './day-flow.js'
import { askIntent } from './session-flow.js'
import { T, hhmm } from './texts.js'

const RITUAL_MAX = 200
const PROFILE_MAX = 2000

// --- Знакомство: пояс, время старта и ритуал, затем сразу работа.

const MOSCOW = 'Europe/Moscow'
const START_PRESETS: Record<string, string> = { st_0900: '09:00', st_1000: '10:00', st_1200: '12:00' }

function ritualKeyboard() {
  return [[{ text: T.skip, data: cb('skip', null, 'ritual') }]]
}

function startTimeKeyboard() {
  return [
    [
      { text: '9:00', data: cb('onb', null, 'st_0900') },
      { text: '10:00', data: cb('onb', null, 'st_1000') },
      { text: '12:00', data: cb('onb', null, 'st_1200') },
    ],
    [
      { text: T.customTime, data: cb('onb', null, 'st_custom') },
      { text: T.startTimeVaries, data: cb('onb', null, 'st_skip') },
    ],
  ]
}

export async function beginOnboarding(ctx: Ctx, user: User): Promise<void> {
  await ctx.db.user.update({ where: { id: user.id }, data: { pendingInput: 'timezone' } })
  await reply(ctx, user, T.welcome(hhmm(ctx.now(), MOSCOW)), [
    [
      { text: T.timezoneYes, data: cb('onb', null, 'tz_yes') },
      { text: T.timezoneNo, data: cb('onb', null, 'tz_no') },
    ],
  ])
}

export async function resumeOnboarding(ctx: Ctx, user: User): Promise<void> {
  if (user.pendingInput === 'ritual') return reply(ctx, user, T.askRitual, ritualKeyboard())
  if (user.pendingInput === 'start_time') return reply(ctx, user, T.askStartTime, startTimeKeyboard())
  await beginOnboarding(ctx, user)
}

export async function isOnboarding(ctx: Ctx, userId: string): Promise<boolean> {
  return (await ctx.db.focusSession.count({ where: { userId } })) === 0
}

// После пояса в знакомстве — время старта; вне знакомства пояс меняется из
// настроек и больше ничего не спрашиваем.
async function afterTimezone(ctx: Ctx, user: User): Promise<'start_time' | 'none'> {
  // Пояс из настроек (settings_timezone) знакомство не перезапускает.
  if (user.pendingInput !== 'timezone') return 'none'
  return (await isOnboarding(ctx, user.id)) && user.ritualText === null ? 'start_time' : 'none'
}

export async function onTimezoneText(ctx: Ctx, user: User, text: string): Promise<void> {
  const clock = parseClock(text)
  if (!clock) return reply(ctx, user, T.badTimezone)
  const now = ctx.now()
  const zone = zoneFromLocalClock(clock, now)
  const next = await afterTimezone(ctx, user)
  await ctx.db.$transaction(async (tx) => {
    await tx.user.update({ where: { id: user.id }, data: { timezone: zone.timezone, pendingInput: next } })
    await logEvent(tx, user.id, 'timezone_set', { offset_minutes: offsetMinutes(zone.timezone, now), via: 'typed' }, { at: now })
    await rescheduleMorning(tx, { ...user, timezone: zone.timezone }, now)
  })
  const updated = { ...user, timezone: zone.timezone }
  await reply(ctx, updated, T.timezoneSet(hhmm(now, zone.timezone)))
  if (next === 'start_time') return reply(ctx, updated, T.askStartTime, startTimeKeyboard())
}

// Кнопки знакомства. Каждая срабатывает только на своём шаге: повторное
// нажатие на старое сообщение не запускает знакомство заново.
export async function onOnboardingButton(ctx: Ctx, user: User, arg: string): Promise<void> {
  const now = ctx.now()
  if (arg === 'tz_yes') {
    const next = await afterTimezone(ctx, user)
    const done = await ctx.db.$transaction(async (tx) => {
      const r = await tx.user.updateMany({ where: { id: user.id, pendingInput: 'timezone' }, data: { timezone: MOSCOW, pendingInput: next } })
      if (r.count !== 1) return false
      await logEvent(tx, user.id, 'timezone_set', { offset_minutes: offsetMinutes(MOSCOW, now), via: 'confirmed' }, { at: now })
      await rescheduleMorning(tx, { ...user, timezone: MOSCOW }, now)
      return true
    })
    if (!done) return reply(ctx, user, T.stale)
    if (next === 'start_time') return reply(ctx, user, T.askStartTime, startTimeKeyboard())
    return reply(ctx, user, T.timezoneSet(hhmm(now, MOSCOW)))
  }
  if (arg === 'tz_no') {
    if (user.pendingInput !== 'timezone') return reply(ctx, user, T.stale)
    return reply(ctx, user, T.askTimezone)
  }
  if (arg === 'st_custom') {
    if (user.pendingInput !== 'start_time') return reply(ctx, user, T.stale)
    return reply(ctx, user, T.askStartTimeCustom)
  }
  if (arg === 'st_skip') return saveStartTime(ctx, user, null)
  const preset = START_PRESETS[arg]
  if (preset) return saveStartTime(ctx, user, preset)
  return reply(ctx, user, T.stale)
}

export async function onStartTimeText(ctx: Ctx, user: User, text: string): Promise<void> {
  const clock = parseClock(text)
  if (!clock) return reply(ctx, user, T.badTimezone)
  await saveStartTime(ctx, user, `${String(clock.h).padStart(2, '0')}:${String(clock.m).padStart(2, '0')}`)
}

// «По-разному» — null: morningTime остаётся по умолчанию.
async function saveStartTime(ctx: Ctx, user: User, value: string | null): Promise<void> {
  const now = ctx.now()
  const done = await ctx.db.$transaction(async (tx) => {
    const r = await tx.user.updateMany({
      where: { id: user.id, pendingInput: 'start_time' },
      data: { pendingInput: 'ritual', ...(value ? { morningTime: value } : {}) },
    })
    if (r.count !== 1) return false
    if (value) {
      await logEvent(tx, user.id, 'settings_changed', { key: 'morning_time' }, { at: now })
      await rescheduleMorning(tx, { ...user, morningTime: value }, now)
    }
    return true
  })
  if (!done) return reply(ctx, user, T.stale)
  await reply(ctx, user, T.askRitual, ritualKeyboard())
}

export async function onRitualText(ctx: Ctx, user: User, text: string | null): Promise<void> {
  const now = ctx.now()
  const ritual = text === null ? null : text.trim().slice(0, RITUAL_MAX)
  await ctx.db.$transaction(async (tx) => {
    await tx.user.update({ where: { id: user.id }, data: { pendingInput: 'none', ...(ritual ? { ritualText: ritual } : {}) } })
    await logEvent(tx, user.id, 'ritual_set', { action: ritual ? 'set' : 'skip' }, { at: now })
  })
  const updated = { ...user, ritualText: ritual ?? user.ritualText, pendingInput: 'none' }
  if (await isOnboarding(ctx, user.id)) return askIntent(ctx, updated, { prefix: T.onboardingGuide })
  await reply(ctx, updated, T.ritualSaved)
}

// --- Настройки. Всё адаптируемое — здесь; правила учёта не настраиваются.

export async function sendSettings(ctx: Ctx, user: User): Promise<void> {
  await reply(
    ctx,
    user,
    T.settings({ technique: user.technique, pings: user.pingsEnabled, proactive: user.proactive, morning: user.morningTime, timezone: user.timezone }),
    [
      [{ text: T.setTechnique, data: cb('set', null, 'technique') }],
      [{ text: T.togglePings, data: cb('set', null, 'pings') }],
      [{ text: T.toggleProactive, data: cb('set', null, 'proactive') }],
      [
        { text: T.setMorning, data: cb('set', null, 'morning') },
        { text: T.setTimezone, data: cb('set', null, 'timezone') },
      ],
    ],
  )
}

export async function onSetting(ctx: Ctx, user: User, arg: string): Promise<void> {
  const now = ctx.now()
  if (arg === 'technique') {
    return reply(ctx, user, T.techniques, [
      [
        { text: 'Помодоро', data: cb('tech', null, 'pomodoro') },
        { text: 'Средний', data: cb('tech', null, 'medium') },
      ],
      [
        { text: 'Длинный', data: cb('tech', null, 'long') },
        { text: 'Свободный', data: cb('tech', null, 'free') },
      ],
      [{ text: 'Сам подберу', data: cb('tech', null, 'auto') }],
    ])
  }
  if (arg === 'morning' || arg === 'timezone') {
    await ctx.db.user.update({ where: { id: user.id }, data: { pendingInput: arg === 'morning' ? 'morning_time' : 'settings_timezone' } })
    return reply(ctx, user, arg === 'morning' ? T.askMorning : T.askTimezone)
  }
  if (arg === 'pings' || arg === 'proactive') {
    await ctx.db.$transaction(async (tx) => {
      if (arg === 'pings') {
        await tx.user.update({ where: { id: user.id }, data: { pingsEnabled: !user.pingsEnabled } })
        if (user.pingsEnabled) {
          // Настройка действует сразу: уже поставленный пинг текущей сессии тоже
          // не должен отвлекать после явного отключения.
          await cancelPending(tx, { userId: user.id, kind: 'ping' })
          await tx.outboxMessage.updateMany({ where: { userId: user.id, kind: 'ping', status: 'paused' }, data: { status: 'canceled' } })
          await tx.focusSession.updateMany({ where: { userId: user.id, state: { in: ['running', 'paused'] } }, data: { pingAt: null } })
        }
      } else {
        await tx.user.update({ where: { id: user.id }, data: { proactive: !user.proactive } })
        // Выключил «писать первым» — снимаем встречи и сводки, которые уже ждут.
        if (user.proactive) await cancelPending(tx, { userId: user.id, kind: { in: ['meeting', 'summary'] } })
        // Включил снова — утро появляется сразу, а не «когда-нибудь».
        else await ensureNextMeeting(tx, { ...user, proactive: true }, now)
      }
      await logEvent(tx, user.id, 'settings_changed', { key: arg === 'pings' ? 'pings_enabled' : 'proactive' }, { at: now })
    })
    const updated = await ctx.db.user.findUniqueOrThrow({ where: { id: user.id } })
    return sendSettings(ctx, updated)
  }
  return reply(ctx, user, T.stale)
}

export async function onTechnique(ctx: Ctx, user: User, arg: string): Promise<void> {
  if (!isTechnique(arg)) return reply(ctx, user, T.stale)
  const now = ctx.now()
  await ctx.db.$transaction(async (tx) => {
    await tx.user.update({ where: { id: user.id }, data: { technique: arg } })
    await logEvent(tx, user.id, 'settings_changed', { key: 'technique' }, { at: now })
  })
  await reply(ctx, user, T.saved)
}

export async function onMorningText(ctx: Ctx, user: User, text: string): Promise<void> {
  const clock = parseClock(text)
  if (!clock) return reply(ctx, user, T.askMorning)
  const value = `${String(clock.h).padStart(2, '0')}:${String(clock.m).padStart(2, '0')}`
  const now = ctx.now()
  await ctx.db.$transaction(async (tx) => {
    await tx.user.update({ where: { id: user.id }, data: { morningTime: value, pendingInput: 'none' } })
    await logEvent(tx, user.id, 'settings_changed', { key: 'morning_time' }, { at: now })
    await rescheduleMorning(tx, { ...user, morningTime: value }, now)
  })
  await reply(ctx, user, T.saved)
}

// --- Личный профиль. Человек видит его целиком и правит руками.

export async function sendProfile(ctx: Ctx, user: User): Promise<void> {
  await reply(ctx, user, T.profile(user.profileText, user.ritualText), [
    [{ text: T.editProfile, data: cb('prof', null, 'edit') }, { text: T.clearProfile, data: cb('prof', null, 'clear') }],
    [{ text: T.editRitual, data: cb('prof', null, 'ritual') }],
  ])
}

export async function onProfileAction(ctx: Ctx, user: User, arg: string): Promise<void> {
  const now = ctx.now()
  if (arg === 'edit') {
    await ctx.db.user.update({ where: { id: user.id }, data: { pendingInput: 'profile' } })
    return reply(ctx, user, T.askProfile)
  }
  if (arg === 'ritual') {
    await ctx.db.user.update({ where: { id: user.id }, data: { pendingInput: 'profile_ritual' } })
    return reply(ctx, user, T.askRitual)
  }
  if (arg === 'clear') {
    await ctx.db.$transaction(async (tx) => {
      await tx.user.update({ where: { id: user.id }, data: { profileText: null } })
      await logEvent(tx, user.id, 'profile_edited', { action: 'clear' }, { at: now })
    })
    return reply(ctx, user, T.saved)
  }
  return reply(ctx, user, T.stale)
}

export async function onProfileText(ctx: Ctx, user: User, text: string): Promise<void> {
  const now = ctx.now()
  await ctx.db.$transaction(async (tx) => {
    await tx.user.update({ where: { id: user.id }, data: { profileText: text.trim().slice(0, PROFILE_MAX), pendingInput: 'none' } })
    await logEvent(tx, user.id, 'profile_edited', { action: 'set' }, { at: now })
  })
  await reply(ctx, user, T.saved)
}

// --- /delete_me. Удаляет по-настоящему: строка пользователя и всё, что к ней
// привязано, уходят каскадом — задачи, сессии с намерениями и отчётами, профиль,
// очередь, очки, связи, приглашения. Журнал событий остаётся, но ссылается на
// псевдоним, связь с которым хранилась только в удалённой строке, — события
// обезличены без единого UPDATE, и текста в них не было никогда.
export async function askDelete(ctx: Ctx, user: User): Promise<void> {
  await reply(ctx, user, T.confirmDelete, [[{ text: T.deleteYes, data: cb('del', null, 'confirm') }]])
}

export async function onDeleteConfirm(ctx: Ctx, user: User): Promise<void> {
  const now = ctx.now()
  const tgId = user.tgId
  await ctx.db.$transaction(async (tx) => {
    await logEvent(tx, user.id, 'user_deleted', {}, { at: now })
    await tx.user.delete({ where: { id: user.id } })
  })
  resetConversationContext(user.id)
  try {
    await ctx.tg.send(tgId, T.deleted, undefined, 'remove')
  } catch {
    // Пользователя уже нет — ни помечать блокировку, ни логировать нечего.
  }
}
