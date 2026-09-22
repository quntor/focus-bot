import type { Prisma } from '@prisma/client'
import type { Db } from '../lib/db.js'
import { dayKey } from '../lib/day.js'
import { isUserAction, type EventType } from './events.js'
import { PAYLOADS, type EventPayload } from './payloads.js'
import { ACTIVE_WINDOW_MS, computeRole, type Role } from './roles.js'

type Options = {
  sessionId?: string
  at?: Date
}

async function roleNow(db: Db, userId: string, at: Date): Promise<{ role: Role; stored: string; subjectId: string; timezone: string }> {
  const user = await db.user.findUniqueOrThrow({
    where: { id: userId },
    select: { role: true, subjectId: true, timezone: true, createdAt: true, countedSessions: true, lastUserActionAt: true },
  })
  // Наблюдатель — только тот, у кого есть живая связь «смотрю за кем-то». Второй
  // запрос делаем, лишь если связь есть: в первой версии их нет ни у кого.
  const watching = await db.relationship.count({ where: { viewerId: userId, revokedAt: null } })
  let observesOnly = false
  if (watching > 0) {
    const own = await db.focusSession.count({
      where: { userId, counted: true, finishedAt: { gte: new Date(at.getTime() - ACTIVE_WINDOW_MS) } },
    })
    observesOnly = own === 0
  }
  const role = computeRole({ ...user, observesOnly }, at)
  return { role, stored: user.role, subjectId: user.subjectId, timezone: user.timezone }
}

async function syncRole(db: Db, userId: string, subjectId: string, from: string, to: Role, day: string, at: Date) {
  if (from === to) return
  await db.roleTransition.create({ data: { subjectId, fromRole: from, toRole: to, dayKey: day, createdAt: at } })
  await db.user.update({ where: { id: userId }, data: { role: to } })
}

// Единственный путь записи в журнал. Здесь:
// - payload проверяется строгой схемой типа — свободный текст не пройдёт;
// - флаг обращения берётся из единого списка;
// - роль пишется на момент события (до него), смена роли — в историю;
// - день считается в поясе пользователя.
// Вызывается внутри той же транзакции, что и изменение состояния.
export async function logEvent<T extends EventType>(
  db: Db,
  userId: string,
  type: T,
  payload: EventPayload<T>,
  opts: Options = {},
): Promise<void> {
  const checked = PAYLOADS[type].parse(payload)
  const at = opts.at ?? new Date()
  const { role, stored, subjectId, timezone } = await roleNow(db, userId, at)
  const day = dayKey(at, timezone)
  await syncRole(db, userId, subjectId, stored, role, day, at)

  const userAction = isUserAction(type)
  await db.event.create({
    data: {
      subjectId,
      sessionId: opts.sessionId ?? null,
      type,
      payload: checked as Prisma.InputJsonValue,
      isUserAction: userAction,
      userRole: role,
      dayKey: day,
      createdAt: at,
    },
  })

  if (userAction) {
    // Действие само по себе меняет роль (уснувший вернулся). Фиксируем переход
    // сразу, а не на следующем событии: иначе история ролей отставала бы.
    await db.user.update({ where: { id: userId }, data: { lastUserActionAt: at } })
    const after = await roleNow(db, userId, at)
    await syncRole(db, userId, subjectId, role, after.role, day, at)
  }
}

// Роль пересчитывается и без событий: уснувшего никто не будит, а разрез «по
// активным» должен это видеть. Сборщик вызывает это для кандидатов на смену.
export async function refreshRole(db: Db, userId: string, at: Date = new Date()): Promise<void> {
  const { role, stored, subjectId, timezone } = await roleNow(db, userId, at)
  await syncRole(db, userId, subjectId, stored, role, dayKey(at, timezone), at)
}
