import type { Db } from '../lib/db.js'
import { log } from '../lib/log.js'
import type { CallMeta, CallMeter } from '../llm/run.js'

// Касания, в которых решение вызывает модель. Закрытый список: имя уходит в
// выгрузку организаторам, и произвольной строки там быть не должно.
export const CALL_NAMES = ['intent', 'report', 'tasks', 'task_match', 'voice_transcription'] as const
export type CallName = (typeof CALL_NAMES)[number]

// Замер вызова модели для конкретного пользователя и касания.
//
// Пишется сразу после вызова, отдельно от транзакции касания: вызов случился,
// даже если состояние потом откатилось (гонка, устаревшая кнопка). Сбой записи
// замера не ломает ответ человеку — он уходит в лог, как и прочие сбои учёта
// вне потока пользователя.
//
// Каждый вызов модели здесь идёт с системным промтом касания — это и есть skill
// в терминах Положения, поэтому skill = имя касания.
export function llmMeter(
  ctx: { db: Db; now: () => Date },
  userId: string,
  name: CallName,
  sessionId: string | null,
): CallMeter {
  return async (meta: CallMeta) => {
    // Время — по часам контекста, как у событий: иначе вызов и действие,
    // сделанные в одном касании, могли бы разъехаться по суткам.
    const at = ctx.now()
    const db = ctx.db
    try {
      const user = await db.user.findUniqueOrThrow({ where: { id: userId }, select: { subjectId: true } })
      await db.componentCall.create({
        data: {
          subjectId: user.subjectId,
          sessionId,
          component: 'llm',
          name,
          skill: name,
          model: meta.model,
          status: meta.status,
          errorCode: meta.errorCode,
          latencyMs: meta.latencyMs,
          inputTokens: meta.usage?.inputTokens ?? null,
          outputTokens: meta.usage?.outputTokens ?? null,
          createdAt: at,
        },
      })
    } catch (error) {
      log.error('component_call_record_failed', error)
    }
  }
}
