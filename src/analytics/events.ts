// Единственный список событий. Новый тип добавляется здесь, и здесь же
// принимается решение, считать ли его обращением пользователя — держать эту
// развилку в одном месте важнее, чем удобство записи в вызывающем коде.
export const EVENT_TYPES = [
  'bot_started',
  'session_started',
  'ping_sent',
  'ping_answered',
  'session_completed',
  'session_abandoned',
  'report_parsed',
  'task_stuck_detected',
  'daily_goal_set',
  'daily_summary_sent',
  'daily_summary_confirmed',
  'streak_frozen',
  'points_awarded',
] as const

export type EventType = (typeof EVENT_TYPES)[number]

// Обращение — то, что сделал человек. Сообщения бота в зачётные метрики не
// попадают: иначе метрику можно поднять рассылкой, не сделав продукт лучше.
export const USER_ACTIONS = [
  'bot_started',
  'session_started',
  'ping_answered',
  'session_completed',
  'daily_goal_set',
  'daily_summary_confirmed',
] as const satisfies readonly EventType[]

// Всё остальное инициировали мы. Список ведётся явно, а не как «остаток»:
// новый тип события не соберётся, пока его не отнесли к одному из двух.
export const BOT_EVENTS = [
  'ping_sent',
  'session_abandoned',
  'report_parsed',
  'task_stuck_detected',
  'daily_summary_sent',
  'streak_frozen',
  'points_awarded',
] as const satisfies readonly EventType[]

const userActions: ReadonlySet<string> = new Set(USER_ACTIONS)

export function isUserAction(type: EventType): boolean {
  return userActions.has(type)
}
