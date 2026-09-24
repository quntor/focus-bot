import type { z } from 'zod'
import type { LlmProvider, LlmRequest } from './provider.js'

export type LlmOutcome<T> = { ok: true; value: T } | { ok: false; reason: 'disabled' | 'error' | 'timeout' | 'invalid' }

// Вызов модели со строгой проверкой ответа. Любое отклонение от схемы — отказ,
// а не попытка «понять, что она имела в виду»: вызывающий уходит на
// детерминированный путь и пишет событие llm_fallback.
export async function runLlm<T>(provider: LlmProvider, req: LlmRequest, schema: z.ZodType<T>): Promise<LlmOutcome<T>> {
  if (!provider.enabled) return { ok: false, reason: 'disabled' }
  let raw: string
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    raw = await Promise.race([
      provider.complete(req),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('timeout')), req.timeoutMs)
      }),
    ])
  } catch (error) {
    return { ok: false, reason: (error as Error).message === 'timeout' ? 'timeout' : 'error' }
  } finally {
    if (timeout) clearTimeout(timeout)
  }
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return { ok: false, reason: 'invalid' }
  }
  const parsed = schema.safeParse(json)
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, reason: 'invalid' }
}
