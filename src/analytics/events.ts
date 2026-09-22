// Единственный список событий. Новый тип добавляется здесь, и здесь же
// принимается решение, считать ли его обращением пользователя — держать эту
// развилку в одном месте важнее, чем удобство записи в вызывающем коде.
// Схема полезной нагрузки каждого типа — в payloads.ts, рядом.
export const EVENT_TYPES = [
  'bot_started',
  'consent_given',
  'timezone_set',
  'intent_submitted',
  'intent_parsed',
  'session_length_adjusted',
  'session_started',
  'session_cancelled',
  'session_expired',
  'ping_sent',
  'ping_answered',
  'session_end_sent',
  'session_completed',
  'session_stopped',
  'session_abandoned',
  'report_submitted',
  'report_parsed',
  'llm_fallback',
  'task_stuck_detected',
  'rest_chosen',
  'rest_over_sent',
  'meeting_scheduled',
  'meeting_defaulted',
  'meeting_sent',
  'meeting_answered',
  'decline_check_sent',
  'daily_goal_set',
  'goal_reached',
  'day_closed',
  'daily_summary_sent',
  'daily_summary_confirmed',
  'streak_extended',
  'streak_frozen',
  'streak_reset',
  'points_awarded',
  'points_capped',
  'settings_changed',
  'profile_edited',
  'ritual_set',
  'outbox_uncertain',
  'user_blocked',
  'user_deleted',
] as const

export type EventType = (typeof EVENT_TYPES)[number]

// Обращение — то, что сделал человек. Сообщения бота в зачётные метрики не
// попадают: иначе метрику можно поднять рассылкой, не сделав продукт лучше.
export const USER_ACTIONS = [
  'bot_started',
  'consent_given',
  'timezone_set',
  'intent_submitted',
  'session_length_adjusted',
  'session_started',
  'session_cancelled',
  'ping_answered',
  'session_completed',
  'session_stopped',
  'report_submitted',
  'rest_chosen',
  'meeting_scheduled',
  'meeting_answered',
  'daily_goal_set',
  'day_closed',
  'daily_summary_confirmed',
  'settings_changed',
  'profile_edited',
  'ritual_set',
  'user_deleted',
] as const satisfies readonly EventType[]

// Всё остальное инициировали мы. Список ведётся явно, а не как «остаток»:
// новый тип события не соберётся, пока его не отнесли к одному из двух.
// Истечение времени (session_expired, session_abandoned по таймауту,
// meeting_defaulted) — тоже «мы»: человек в этот момент ничего не делал.
export const BOT_EVENTS = [
  'intent_parsed',
  'session_expired',
  'ping_sent',
  'session_end_sent',
  'session_abandoned',
  'report_parsed',
  'llm_fallback',
  'task_stuck_detected',
  'rest_over_sent',
  'meeting_defaulted',
  'meeting_sent',
  'decline_check_sent',
  'goal_reached',
  'daily_summary_sent',
  'streak_extended',
  'streak_frozen',
  'streak_reset',
  'points_awarded',
  'points_capped',
  'outbox_uncertain',
  'user_blocked',
] as const satisfies readonly EventType[]

const userActions: ReadonlySet<string> = new Set(USER_ACTIONS)

export function isUserAction(type: EventType): boolean {
  return userActions.has(type)
}
