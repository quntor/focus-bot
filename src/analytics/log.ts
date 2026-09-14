import type { Prisma } from '@prisma/client'
import { prisma } from '../lib/db.js'
import { dayKey } from '../lib/day.js'
import { isUserAction, type EventType } from './events.js'

type LogEventInput = {
  userId: string
  type: EventType
  timezone: string
  sessionId?: string
  payload?: Record<string, unknown>
  at?: Date
}

// Запись события отделена от списка типов намеренно: классификацию читают и
// тесты, и отчёты по метрикам, а тянуть ради неё пул соединений незачем.
export async function logEvent(input: LogEventInput): Promise<void> {
  const at = input.at ?? new Date()
  await prisma.event.create({
    data: {
      userId: input.userId,
      sessionId: input.sessionId ?? null,
      type: input.type,
      // Prisma требует свой тип JSON-входа и не принимает null внутри объекта.
      // Приводим в одном месте, чтобы вызывающий код писал обычный объект.
      payload: input.payload as Prisma.InputJsonValue | undefined,
      isUserAction: isUserAction(input.type),
      dayKey: dayKey(at, input.timezone),
      createdAt: at,
    },
  })
}
