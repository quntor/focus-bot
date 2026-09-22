import type { Db } from '../lib/db.js'
import { logEvent } from '../analytics/log.js'
import { DAILY_CAP } from './rules.js'

type Reason = 'session_completed' | 'daily_goal' | 'comeback'

// Начисление. Детерминированное, на сервере, идемпотентное по refKey, с потолком
// на сутки пользователя. Вызывается только внутри транзакции, где меняется
// состояние: начисление, серия и событие либо происходят вместе, либо никак.
//
// Потолок считается под advisory-блокировкой пользователя: две параллельные
// транзакции иначе обе увидели бы «до потолка 10» и обе начислили бы по 10.
export async function award(
  db: Db,
  input: { userId: string; dayKey: string; reason: Reason; refKey: string; amount: number; at: Date },
): Promise<number> {
  await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${input.userId}))`

  const existing = await db.pointsEntry.findUnique({ where: { refKey: input.refKey } })
  if (existing) return 0

  const today = await db.pointsEntry.aggregate({
    where: { userId: input.userId, dayKey: input.dayKey },
    _sum: { amount: true },
  })
  const room = Math.max(0, DAILY_CAP - (today._sum.amount ?? 0))
  const amount = Math.min(input.amount, room)

  if (amount > 0) {
    await db.pointsEntry.create({
      data: { userId: input.userId, dayKey: input.dayKey, amount, reason: input.reason, refKey: input.refKey, createdAt: input.at },
    })
    await logEvent(db, input.userId, 'points_awarded', { amount, reason: input.reason }, { at: input.at })
  }
  if (amount < input.amount) {
    await logEvent(db, input.userId, 'points_capped', { reason: input.reason, requested: input.amount, awarded: amount }, { at: input.at })
  }
  return amount
}
