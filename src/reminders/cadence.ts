import type { ReminderChain, User } from '@prisma/client'
import { dayKey } from '../lib/day.js'
import { localDateTime, nextLocalTime, parseClock } from '../lib/time.js'
export const MIN = 60_000
export type Phase = 'morning' | 'work' | 'break' | 'post_rest'
export function repeatMinutes(kind: string, interval: number, step: number): number {
  return kind === 'morning' ? 60 : kind === 'work' ? interval : [10, 30, 60, 120][Math.min(step, 3)]!
}
export function midnight(user: Pick<User, 'timezone'>, now: Date): Date {
  return nextLocalTime(user.timezone, { h: 0, m: 0 }, now)
}
// Unsupported shifted windows are deliberately disabled, not treated as all-day.
export function allowedAt(user: Pick<User, 'timezone'|'morningTime'|'eveningTime'|'quietUntil'>, chain: Pick<ReminderChain, 'nightUntil'>, now: Date): Date | null {
  const morning = parseClock(user.morningTime), evening = parseClock(user.eveningTime)
  if (!morning || !evening || morning.h * 60 + morning.m >= evening.h * 60 + evening.m) return null
  const at = user.quietUntil && user.quietUntil > now ? user.quietUntil : now
  if (chain.nightUntil && chain.nightUntil > at) return at
  const date = dayKey(at, user.timezone)
  const start = localDateTime(user.timezone, date, morning), end = localDateTime(user.timezone, date, evening)
  if (at < start) return start
  if (at >= end) return nextLocalTime(user.timezone, morning, at)
  return at
}
export function nightAllowance(user: User, now: Date): Date | null {
  const allowed = allowedAt({ ...user, quietUntil: null }, { nightUntil: null }, now)
  return allowed && allowed > now ? nextLocalTime(user.timezone, parseClock(user.morningTime)!, now) : null
}
