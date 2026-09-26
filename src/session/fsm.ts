import type { Prisma } from '@prisma/client'
import type { Db } from '../lib/db.js'

// Конечный автомат сессии. Состояния и разрешённые переходы — только здесь.
//
//   collecting_intent ── подтверждение ──> running ── отчёт ──> finished(outcome)
//                                      └─> paused ──> running | finished | abandoned
//   collecting_intent ── отмена/таймаут ──> cancelled
//   running ── /stop, таймаут+1ч, молчание на пинги ──> abandoned
//
// Ответ на пинг — не переход, а событие внутри running.
// cancelled добавлен к исходной схеме: передумавший на вопросе «с чего начнёшь»
// не бросал работу, и считать его abandoned значит испортить долю доведённых.
export const STATES = ['collecting_intent', 'running', 'paused', 'finished', 'abandoned', 'cancelled'] as const
export type State = (typeof STATES)[number]
export const ACTIVE_STATES = ['collecting_intent', 'running', 'paused'] as const satisfies readonly State[]

export const OUTCOMES = ['done', 'not_done', 'other'] as const
export type Outcome = (typeof OUTCOMES)[number]

const TRANSITIONS: Record<State, readonly State[]> = {
  collecting_intent: ['running', 'cancelled'],
  running: ['paused', 'finished', 'abandoned'],
  paused: ['running', 'finished', 'abandoned'],
  finished: [],
  abandoned: [],
  cancelled: [],
}

export function canTransition(from: State, to: State): boolean {
  return TRANSITIONS[from].includes(to)
}

// Переход, которого нет в таблице, — ошибка программиста.
export class IllegalTransition extends Error {
  override name = 'IllegalTransition'
  constructor(
    readonly from: State,
    readonly to: State,
  ) {
    super(`переход ${from} -> ${to} запрещён`)
  }
}

// Переход разрешён, но сессия уже не в исходном состоянии: двойной клик,
// повторная доставка, гонка с тем же пользователем. Это не молчаливое
// игнорирование — вызывающий обязан ответить «уже неактуально».
export class StaleTransition extends Error {
  override name = 'StaleTransition'
}

// Переход выполняется одним UPDATE с условием на владельца и исходное
// состояние. Проверка «прочитать, сравнить, записать» проиграла бы гонку.
export async function transition(
  db: Db,
  ref: { sessionId: string; userId: string },
  from: State,
  to: State,
  data: Omit<Prisma.FocusSessionUpdateManyMutationInput, 'state'> = {},
): Promise<void> {
  if (!canTransition(from, to)) throw new IllegalTransition(from, to)
  const res = await db.focusSession.updateMany({
    where: { id: ref.sessionId, userId: ref.userId, state: from },
    data: { ...data, state: to },
  })
  if (res.count !== 1) throw new StaleTransition()
}
