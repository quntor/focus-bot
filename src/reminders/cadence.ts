import type { ReminderChain, User } from '@prisma/client'
import { addDays, dayKey } from '../lib/day.js'
import { localDateTime, nextLocalTime, parseClock } from '../lib/time.js'
export const MIN = 60_000
export type Phase = 'morning' | 'work' | 'break' | 'post_rest'
export function repeatMinutes(kind: string, interval: number, step: number): number {
  return kind === 'morning' ? 60 : kind === 'work' ? interval : [10, 30, 60, 120][Math.min(step, 3)]!
}
export function midnight(user: Pick<User, 'timezone'>, now: Date): Date {
  return nextLocalTime(user.timezone, { h: 0, m: 0 }, now)
}
type Schedule = Pick<User, 'timezone'|'morningTime'|'eveningTime'|'quietUntil'> & Partial<Pick<User, 'notificationDays'>>
export function messageDayEnabled(user: Pick<Schedule, 'timezone'|'notificationDays'>, at: Date): boolean {
  const day = dayKey(at, user.timezone)
  const weekday = (new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7
  return ((user.notificationDays ?? 127) & (1 << weekday)) !== 0
}
// Summary alone owns the entire configured evening minute (workers run with
// second-level delay). Quiet and malformed windows never get an exception.
export function summaryAllowedAt(user: Schedule, now: Date): Date | null {
  const morning = parseClock(user.morningTime), evening = parseClock(user.eveningTime)
  if (messageDayEnabled(user, now) && morning && evening && morning.h * 60 + morning.m < evening.h * 60 + evening.m && (!user.quietUntil || user.quietUntil <= now)) {
    const end = localDateTime(user.timezone, dayKey(now, user.timezone), evening)
    if (now >= end && now.getTime() < end.getTime() + MIN) return now
  }
  return allowedAt(user, { nightUntil: null }, now)
}
// Unsupported shifted windows are deliberately disabled, not treated as all-day.
export function allowedAt(user: Schedule, chain: Pick<ReminderChain, 'nightUntil'>, now: Date): Date | null {
  const morning = parseClock(user.morningTime), evening = parseClock(user.eveningTime)
  if (!morning || !evening || morning.h * 60 + morning.m >= evening.h * 60 + evening.m) return null
  const at = user.quietUntil && user.quietUntil > now ? user.quietUntil : now
  const date = dayKey(at, user.timezone)
  for (let i = 0; i <= 7; i++) {
    const day = addDays(date, i)
    const start = localDateTime(user.timezone, day, morning), end = localDateTime(user.timezone, day, evening)
    if (!messageDayEnabled(user, start)) continue
    if (i === 0 && chain.nightUntil && chain.nightUntil > at) return at
    if (at < start) return start
    if (at < end) return at
  }
  return null
}
export function nightAllowance(user: User, now: Date): Date | null {
  const allowed = allowedAt({ ...user, notificationDays: 127, quietUntil: null }, { nightUntil: null }, now)
  return allowed && allowed > now ? nextLocalTime(user.timezone, parseClock(user.morningTime)!, now) : null
}
