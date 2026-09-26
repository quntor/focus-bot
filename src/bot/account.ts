import type { User } from '@prisma/client'
import { logEvent } from '../analytics/log.js'
import { parseClock, zoneFromLocalClock, offsetMinutes } from '../lib/time.js'
import { cancelPending } from '../outbox/queue.js'
import { isTechnique } from '../session/technique.js'
import { cb } from './callbacks.js'
import { reply, type Ctx } from './context.js'
import { askIntent } from './session-flow.js'
import { T, hhmm } from './texts.js'

const RITUAL_MAX = 200
const PROFILE_MAX = 2000

// --- Знакомство: пояс и ритуал, затем сразу работа.

export async function beginOnboarding(ctx: Ctx, user: User): Promise<void> {
  await ctx.db.user.update({ where: { id: user.id }, data: { pendingInput: 'timezone' } })
  await reply(ctx, user, T.welcome)
}

export async function resumeOnboarding(ctx: Ctx, user: User): Promise<void> {
  if (user.pendingInput === 'ritual') {
    return reply(ctx, user, T.askRitual, [[{ text: T.skip, data: cb('skip', null, 'ritual') }]])
  }
  await beginOnboarding(ctx, user)
}

async function isOnboarding(ctx: Ctx, userId: string): Promise<boolean> {
  return (await ctx.db.focusSession.count({ where: { userId } })) === 0
}

export async function onTimezoneText(ctx: Ctx, user: User, text: string): Promise<void> {
  const clock = parseClock(text)
  if (!clock) return reply(ctx, user, T.badTimezone)
  const now = ctx.now()
  const zone = zoneFromLocalClock(clock, now)
  const onboarding = await isOnboarding(ctx, user.id)
  const next = onboarding && user.ritualText === null ? 'ritual' : 'none'
  await ctx.db.$transaction(async (tx) => {
    await tx.user.update({ where: { id: user.id }, data: { timezone: zone.timezone, pendingInput: next } })
    await logEvent(tx, user.id, 'timezone_set', { offset_minutes: offsetMinutes(zone.timezone, now) }, { at: now })
  })
  const updated = { ...user, timezone: zone.timezone }
  await reply(ctx, updated, T.timezoneSet(hhmm(now, zone.timezone)))
  if (next === 'ritual') return reply(ctx, updated, T.askRitual, [[{ text: T.skip, data: cb('skip', null, 'ritual') }]])
}

export async function onRitualText(ctx: Ctx, user: User, text: string | null): Promise<void> {
  const now = ctx.now()
  const ritual = text === null ? null : text.trim().slice(0, RITUAL_MAX)
  await ctx.db.$transaction(async (tx) => {
    await tx.user.update({ where: { id: user.id }, data: { pendingInput: 'none', ...(ritual ? { ritualText: ritual } : {}) } })
    await logEvent(tx, user.id, 'ritual_set', { action: ritual ? 'set' : 'skip' }, { at: now })
  })
  const updated = { ...user, ritualText: ritual ?? user.ritualText, pendingInput: 'none' }
  if (await isOnboarding(ctx, user.id)) return askIntent(ctx, updated)
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
    await ctx.db.user.update({ where: { id: user.id }, data: { pendingInput: arg === 'morning' ? 'morning_time' : 'timezone' } })
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
    await ctx.db.user.update({ where: { id: user.id }, data: { pendingInput: 'ritual' } })
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
  try {
    await ctx.tg.send(tgId, T.deleted)
  } catch {
    // Пользователя уже нет — ни помечать блокировку, ни логировать нечего.
  }
}
