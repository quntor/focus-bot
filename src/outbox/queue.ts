import type { Prisma } from '@prisma/client'
import type { Db } from '../lib/db.js'

export type OutboxKind = 'ping' | 'session_end' | 'rest_over' | 'meeting' | 'summary'

// Постановка в очередь внутри транзакции вызывающего. Дубль по ключу молча
// отбрасывается (ON CONFLICT DO NOTHING): повторный вызов — не ошибка, а
// ожидаемый случай, и падать из-за него в середине транзакции нельзя.
export async function enqueue(
  db: Db,
  input: { userId: string; kind: OutboxKind; key: string; sendAfter: Date; payload?: Record<string, string | number | boolean | null> },
): Promise<void> {
  await db.outboxMessage.createMany({
    data: [
      {
        userId: input.userId,
        kind: input.kind,
        idempotencyKey: input.key,
        sendAfter: input.sendAfter,
        payload: (input.payload ?? {}) as Prisma.InputJsonValue,
      },
    ],
    skipDuplicates: true,
  })
}

// Отмена ещё не взятых в работу сообщений. Уже отправленные не трогаем.
export async function cancelPending(db: Db, where: Prisma.OutboxMessageWhereInput): Promise<void> {
  await db.outboxMessage.updateMany({ where: { ...where, status: 'pending' }, data: { status: 'canceled' } })
}
