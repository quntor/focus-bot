import { randomUUID } from 'node:crypto'
import type { PrismaClient } from '@prisma/client'
import { log } from '../lib/log.js'
import type { CallMeta, CallMeter } from '../llm/run.js'
import { logEvent } from './log.js'

// Касания, в которых решение вызывает модель. Закрытый список: имя уходит в
// выгрузку организаторам, и произвольной строки там быть не должно.
export const CALL_NAMES = ['semantic_router', 'intent', 'report', 'tasks', 'task_match', 'session_help', 'reminder_text', 'task_breakdown', 'voice_transcription'] as const
export type CallName = (typeof CALL_NAMES)[number]

// Дневной лимит вызовов модели (и распознавания голоса) на пользователя, за
// скользящие сутки. Активному человеку нужно 60–100: запас втрое. Без лимита
// один аккаунт со скриптом (30 сообщений в минуту, 2–4 вызова на каждое) сжёг
// бы квоту ключа для всех, а его «обращения» выглядели бы накруткой. Сверх
// лимита бот работает на шаблонах, как без модели.
export const LLM_CALLS_PER_DAY = 300
const DAY_MS = 86_400_000

// Reservations charge the budget before network I/O. They remain charged on
// crash/unknown outcome; the immutable component journal contains only actual
// attempts measured by runLlm. Linking the two prevents double counting.
export function llmMeter(
  ctx: { db: PrismaClient; now: () => Date },
  userId: string,
  name: CallName,
  sessionId: string | null,
): CallMeter {
  const reservations: string[] = []
  const meter: CallMeter = async (meta: CallMeta) => {
    const at = ctx.now()
    const reservationId = reservations.shift()
    try {
      await ctx.db.$transaction(async (tx) => {
        const user = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: { subjectId: true } })
        const call = await tx.componentCall.create({
          data: {
            subjectId: user.subjectId, sessionId, component: 'llm', name, skill: name,
            model: meta.model, status: meta.status, errorCode: meta.errorCode,
            latencyMs: meta.latencyMs, inputTokens: meta.usage?.inputTokens ?? null,
            outputTokens: meta.usage?.outputTokens ?? null, createdAt: at,
          },
        })
        if (reservationId) await tx.$executeRaw`
          UPDATE llm_budget_reservations SET component_call_id = ${call.id}
          WHERE id = ${reservationId} AND subject_id = ${user.subjectId} AND component_call_id IS NULL`
      })
    } catch (error) {
      // Reservation survives a journal failure: do not reopen quota for an
      // attempt whose outcome could not be durably recorded.
      log.error('component_call_record_failed', error)
    }
  }
  meter.allow = async () => {
    const at = ctx.now()
    const since = new Date(at.getTime() - DAY_MS)
    const reservationId = randomUUID()
    try {
      const allowed = await ctx.db.$transaction(async (tx) => {
        const user = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: { subjectId: true } })
        // All lanes and processes use the same per-subject transaction lock.
        // Only the DB reservation is locked; the network call never is.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`llm_budget:${user.subjectId}`}, 0))`
        const rows = await tx.$queryRaw<{ used: bigint }[]>`
          SELECT (
            (SELECT COUNT(*) FROM llm_budget_reservations WHERE subject_id = ${user.subjectId} AND reserved_at >= ${since}) +
            (SELECT COUNT(*) FROM component_calls c WHERE c.subject_id = ${user.subjectId} AND c.created_at >= ${since}
              AND NOT EXISTS (SELECT 1 FROM llm_budget_reservations r WHERE r.component_call_id = c.id AND r.reserved_at >= ${since}))
          ) AS used`
        if (Number(rows[0]?.used ?? LLM_CALLS_PER_DAY) >= LLM_CALLS_PER_DAY) {
          const noted = await tx.event.count({ where: { subjectId: user.subjectId, type: 'llm_budget_exceeded', createdAt: { gte: since } } })
          if (noted === 0) await logEvent(tx, userId, 'llm_budget_exceeded', { limit: LLM_CALLS_PER_DAY }, { at })
          return false
        }
        await tx.$executeRaw`
          INSERT INTO llm_budget_reservations (id, subject_id, reserved_at)
          VALUES (${reservationId}, ${user.subjectId}, ${at})`
        return true
      })
      if (allowed) reservations.push(reservationId)
      return allowed
    } catch (error) {
      // A hard quota cannot fail open when reservation storage is unavailable.
      log.error('llm_budget_check_failed', error)
      return false
    }
  }
  return meter
}
