import { z } from 'zod'
import type { LlmProvider, LlmRequest } from './provider.js'

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

type Options = {
  apiKey: string
  baseUrl: string
  model: string
  fetchFn?: FetchLike
}

const responseSchema = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({ content: z.string() }),
      }),
    )
    .min(1),
})

class SafeProviderError extends Error {}

export function createOpenAiCompatibleProvider(options: Options): LlmProvider {
  const fetchFn = options.fetchFn ?? fetch
  const url = `${options.baseUrl.replace(/\/+$/, '')}/chat/completions`

  return {
    enabled: true,
    async complete(req: LlmRequest): Promise<string> {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), req.timeoutMs)
      try {
        const response = await fetchFn(url, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${options.apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            model: options.model,
            max_tokens: req.maxTokens,
            temperature: 0,
            messages: [
              { role: 'system', content: req.system },
              { role: 'user', content: req.input },
            ],
          }),
          signal: controller.signal,
        })

        // Тело ошибки провайдера не пробрасываем: оно не нужно продукту и может
        // содержать отражённый запрос или служебные данные внешнего сервиса.
        if (!response.ok) throw new SafeProviderError(`LLM request failed (HTTP ${response.status})`)

        let body: unknown
        try {
          body = await response.json()
        } catch {
          throw new SafeProviderError('Invalid LLM response')
        }
        const parsed = responseSchema.safeParse(body)
        if (!parsed.success) throw new SafeProviderError('Invalid LLM response')
        return parsed.data.choices[0]!.message.content
      } catch (error) {
        if (controller.signal.aborted) throw new Error('timeout')
        if (error instanceof SafeProviderError) throw error
        throw new Error('LLM request failed')
      } finally {
        clearTimeout(timeout)
      }
    },
  }
}
