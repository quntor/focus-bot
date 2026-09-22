import { z } from 'zod'
import type { EventType } from './events.js'

// Схема полезной нагрузки каждого события. Выгрузка событий уходит наружу, поэтому
// здесь действует жёсткое правило: только идентификаторы, числа, флаги и значения
// из закрытых списков. Строкового поля «произвольный текст» нет ни у одного типа,
// и схемы строгие — лишний ключ с формулировкой задачи не пройдёт молча.
//
// Запись события с payload, не прошедшим схему, падает (src/analytics/log.ts):
// это ошибка программиста, и лучше увидеть её в тесте, чем в выгрузке.

const id = z.uuid()
const minutes = z.int().min(0).max(24 * 60)
const dayKey = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const empty = z.strictObject({})

export const OUTCOMES = ['done', 'not_done', 'other'] as const
export const MINUTES_SOURCES = ['user', 'bot'] as const
export const TECHNIQUES = ['auto', 'pomodoro', 'medium', 'long', 'free'] as const
export const REST_CHOICES = ['rest', 'continue', 'later', 'day_end'] as const
export const SCOPES = ['step', 'multi_session'] as const
export const POINT_REASONS = ['session_completed', 'daily_goal', 'comeback'] as const
export const LLM_STAGES = ['intent', 'report'] as const
export const LLM_FALLBACK_REASONS = ['disabled', 'error', 'timeout', 'invalid'] as const
export const OUTBOX_KINDS = ['ping', 'session_end', 'rest_over', 'meeting', 'summary'] as const
export const SETTINGS_KEYS = [
  'technique',
  'pings_enabled',
  'proactive',
  'morning_time',
  'evening_time',
  'timezone',
] as const

export const PAYLOADS = {
  // Метка источника проходит parseSource: [a-z0-9_-]{1,32}, это не текст человека.
  bot_started: z.strictObject({ source: z.string().regex(/^[a-z0-9_-]{1,32}$/).nullable(), returning: z.boolean() }),
  consent_given: empty,
  timezone_set: z.strictObject({ offset_minutes: z.int().min(-12 * 60).max(14 * 60) }),
  intent_submitted: z.strictObject({ length_chars: z.int().min(0), named_minutes: z.boolean() }),
  intent_parsed: z.strictObject({
    llm_used: z.boolean(),
    task_id: id.nullable(),
    is_new_task: z.boolean(),
    scope: z.enum(SCOPES),
  }),
  session_length_adjusted: z.strictObject({ direction: z.enum(['up', 'down']), planned_minutes: minutes }),
  session_started: z.strictObject({
    task_id: id.nullable(),
    is_new_task: z.boolean(),
    planned_minutes: minutes.nullable(),
    planned_rest_minutes: minutes,
    minutes_source: z.enum(MINUTES_SOURCES),
    technique: z.enum(TECHNIQUES),
    scope: z.enum(SCOPES),
  }),
  session_cancelled: empty,
  session_expired: empty,
  ping_sent: z.strictObject({ session_id: id }),
  ping_answered: z.strictObject({ session_id: id, latency_sec: z.int().min(0) }),
  session_end_sent: z.strictObject({ session_id: id }),
  session_completed: z.strictObject({
    session_id: id,
    outcome: z.enum(OUTCOMES),
    elapsed_minutes: minutes,
    early: z.boolean(),
    counted: z.boolean(),
  }),
  session_stopped: z.strictObject({ session_id: id, elapsed_minutes: minutes }),
  session_abandoned: z.strictObject({ session_id: id, reason: z.enum(['timeout', 'no_ping']) }),
  report_submitted: z.strictObject({ session_id: id, length_chars: z.int().min(0) }),
  report_parsed: z.strictObject({ session_id: id, llm_used: z.boolean(), progress: z.enum(['moved', 'stuck']).nullable() }),
  llm_fallback: z.strictObject({ stage: z.enum(LLM_STAGES), reason: z.enum(LLM_FALLBACK_REASONS) }),
  task_stuck_detected: z.strictObject({ task_id: id, sessions_without_progress: z.int().min(0) }),
  rest_chosen: z.strictObject({ session_id: id, choice: z.enum(REST_CHOICES), rest_minutes: minutes }),
  rest_over_sent: z.strictObject({ session_id: id }),
  meeting_scheduled: z.strictObject({
    kind: z.enum(['morning', 'in_hours', 'evening', 'custom', 'postpone']),
    minutes_ahead: z.int().min(0),
  }),
  meeting_defaulted: z.strictObject({ minutes_ahead: z.int().min(0) }),
  meeting_sent: empty,
  meeting_answered: z.strictObject({ response: z.enum(['start', 'postpone']) }),
  decline_check_sent: z.strictObject({ declines_in_row: z.int().min(0) }),
  daily_goal_set: z.strictObject({ target_sessions: z.int().min(1).max(20) }),
  goal_reached: z.strictObject({ day_key: dayKey, target_sessions: z.int().min(1) }),
  day_closed: z.strictObject({ day_key: dayKey, via: z.enum(['button', 'command']) }),
  daily_summary_sent: z.strictObject({ day_key: dayKey }),
  daily_summary_confirmed: z.strictObject({ day_key: dayKey, sessions: z.int().min(0) }),
  streak_extended: z.strictObject({ day_key: dayKey, current: z.int().min(0) }),
  streak_frozen: z.strictObject({ day_key: dayKey, freezes_left: z.int().min(0) }),
  streak_reset: z.strictObject({ day_key: dayKey, previous: z.int().min(0), repairable: z.boolean() }),
  streak_repaired: z.strictObject({ day_key: dayKey, current: z.int().min(0) }),
  day_off_planned: z.strictObject({ day_key: dayKey }),
  points_awarded: z.strictObject({ amount: z.int().min(1), reason: z.enum(POINT_REASONS) }),
  points_capped: z.strictObject({ reason: z.enum(POINT_REASONS), requested: z.int().min(0), awarded: z.int().min(0) }),
  settings_changed: z.strictObject({ key: z.enum(SETTINGS_KEYS) }),
  profile_edited: z.strictObject({ action: z.enum(['set', 'clear']) }),
  ritual_set: z.strictObject({ action: z.enum(['set', 'skip', 'clear']) }),
  outbox_uncertain: z.strictObject({ kind: z.enum(OUTBOX_KINDS), outbox_id: id }),
  user_blocked: empty,
  user_deleted: empty,
} as const satisfies Record<EventType, z.ZodType>

export type EventPayload<T extends EventType> = z.infer<(typeof PAYLOADS)[T]>
