// Роль пользователя: new | active | observer | dormant. Определения
// предварительные (согласованы 22.09.2026), пороги — здесь и только здесь, чтобы
// поправить их одной правкой. Роль пишется в каждое событие на момент события:
// дашборд считает DAU и обращения и по всей базе, и по активным, а методика
// зачёта пока неизвестна.
export const ROLES = ['new', 'active', 'observer', 'dormant'] as const
export type Role = (typeof ROLES)[number]

const DAY = 86_400_000
export const NEW_DAYS = 7
export const NEW_MAX_COUNTED = 3
export const ACTIVE_DAYS = 7

export type RoleInput = {
  createdAt: Date
  countedSessions: number
  lastUserActionAt: Date | null
  // Смотрит за кем-то и сам за последние ACTIVE_DAYS засчитанных сессий не вёл.
  observesOnly: boolean
}

export function computeRole(input: RoleInput, now: Date): Role {
  if (now.getTime() - input.createdAt.getTime() < NEW_DAYS * DAY && input.countedSessions < NEW_MAX_COUNTED) return 'new'
  if (input.observesOnly) return 'observer'
  if (input.lastUserActionAt && now.getTime() - input.lastUserActionAt.getTime() < ACTIVE_DAYS * DAY) return 'active'
  return 'dormant'
}

export const ACTIVE_WINDOW_MS = ACTIVE_DAYS * DAY
