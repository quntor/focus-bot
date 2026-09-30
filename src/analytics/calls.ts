import type { Db } from '../lib/db.js'
import { log } from '../lib/log.js'
import type { CallMeta, CallMeter } from '../llm/run.js'
import { logEvent } from './log.js'

// Касания, в которых решение вызывает модель. Закрытый список: имя уходит в
// выгрузку организаторам, и произвольной строки там быть не должно.
export const CALL_NAMES = ['intent', 'report', 'tasks', 'task_match', 'session_help', 'task_breakdown', 'voice_transcription'] as const
export type CallName = (typeof CALL_NAMES)[number]

// Дневной лимит вызовов модели (и распознавания голоса) на пользователя, за
// скользящие сутки. Активному человеку нужно 60–100: запас втрое. Без лимита
// один аккаунт со скриптом (30 сообщений в минуту, 2–4 вызова на каждое) сжёг
// бы квоту ключа для всех, а его «обращения» выглядели бы накруткой. Сверх
// лимита бот работает на шаблонах, как без модели.
export const LLM_CALLS_PER_DAY = 300
const DAY_MS = 86_400_000

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
  const meter: CallMeter = async (meta: CallMeta) => {
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
  meter.allow = async () => {
    const db = ctx.db
    const at = ctx.now()
    try {
      const user = await db.user.findUniqueOrThrow({ where: { id: userId }, select: { subjectId: true } })
      const since = new Date(at.getTime() - DAY_MS)
      const used = await db.componentCall.count({ where: { subjectId: user.subjectId, createdAt: { gte: since } } })
      if (used < LLM_CALLS_PER_DAY) return true
      const noted = await db.event.count({ where: { subjectId: user.subjectId, type: 'llm_budget_exceeded', createdAt: { gte: since } } })
      if (noted === 0) await logEvent(db, userId, 'llm_budget_exceeded', { limit: LLM_CALLS_PER_DAY }, { at })
      return false
    } catch (error) {
      // Сбой проверки не должен выключать модель у человека: учёт — вне его потока.
      log.error('llm_budget_check_failed', error)
      return true
    }
  }
  return meter
}
