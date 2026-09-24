import type { z } from 'zod'
import { LlmCallError, type LlmProvider, type LlmReply, type LlmRequest } from './provider.js'

export type LlmOutcome<T> = { ok: true; value: T } | { ok: false; reason: 'disabled' | 'error' | 'timeout' | 'invalid' }

// Замер одного реального вызова модели — для журнала вызовов компонентов
// (Положение, Прил. 2, п. 2.2: зачётное «обращение» — вызов решением своих
// компонентов). Отказ схемы — тоже вызов: модель ответила, ответ не годится.
export type CallMeta = {
  latencyMs: number
  status: 'ok' | 'error' | 'timeout' | 'invalid'
  // Машинный код без текста ответа: http_402, network, timeout, not_json, schema.
  errorCode: string | null
  model: string | null
  usage: LlmReply['usage']
}

// Куда отдать замер. Вызывающий знает пользователя и касание, run.ts — нет.
export type CallMeter = (meta: CallMeta) => Promise<void>

// Вызов модели со строгой проверкой ответа. Любое отклонение от схемы — отказ,
// а не попытка «понять, что она имела в виду»: вызывающий уходит на
// детерминированный путь и пишет событие llm_fallback.
//
// Выключенный провайдер вызова не делает, и замера нет: учитываем только то,
// что действительно ушло к модели.
export async function runLlm<T>(
  provider: LlmProvider,
  req: LlmRequest,
  schema: z.ZodType<T>,
  meter?: CallMeter,
): Promise<LlmOutcome<T>> {
  if (!provider.enabled) return { ok: false, reason: 'disabled' }
  const t0 = performance.now()
  const measure = async (status: CallMeta['status'], errorCode: string | null, usage: LlmReply['usage']) => {
    if (!meter) return
    await meter({ latencyMs: Math.round(performance.now() - t0), status, errorCode, model: provider.model, usage })
  }

  let reply: LlmReply
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    reply = await Promise.race([
      provider.complete(req),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('timeout')), req.timeoutMs)
      }),
    ])
  } catch (error) {
    const isTimeout = (error as Error).message === 'timeout'
    await measure(isTimeout ? 'timeout' : 'error', isTimeout ? 'timeout' : error instanceof LlmCallError ? error.code : 'error', null)
    return { ok: false, reason: isTimeout ? 'timeout' : 'error' }
  } finally {
    if (timeout) clearTimeout(timeout)
  }
  let json: unknown
  try {
    json = JSON.parse(reply.text)
  } catch {
    await measure('invalid', 'not_json', reply.usage)
    return { ok: false, reason: 'invalid' }
  }
  const parsed = schema.safeParse(json)
  await measure(parsed.success ? 'ok' : 'invalid', parsed.success ? null : 'schema', reply.usage)
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, reason: 'invalid' }
}
