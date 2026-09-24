import { z } from 'zod'
import { LlmCallError, type LlmProvider, type LlmReply, type LlmRequest } from './provider.js'

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
  // Расход токенов у OpenAI-compatible API необязателен: нет — пишем null.
  usage: z.object({ prompt_tokens: z.int().min(0), completion_tokens: z.int().min(0) }).nullish(),
})

export function createOpenAiCompatibleProvider(options: Options): LlmProvider {
  const fetchFn = options.fetchFn ?? fetch
  const url = `${options.baseUrl.replace(/\/+$/, '')}/chat/completions`

  return {
    enabled: true,
    model: options.model,
    async complete(req: LlmRequest): Promise<LlmReply> {
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
        if (!response.ok) throw new LlmCallError(`LLM request failed (HTTP ${response.status})`, `http_${response.status}`)

        let body: unknown
        try {
          body = await response.json()
        } catch {
          throw new LlmCallError('Invalid LLM response', 'bad_response')
        }
        const parsed = responseSchema.safeParse(body)
        if (!parsed.success) throw new LlmCallError('Invalid LLM response', 'bad_response')
        const usage = parsed.data.usage
        return {
          text: parsed.data.choices[0]!.message.content,
          usage: usage ? { inputTokens: usage.prompt_tokens, outputTokens: usage.completion_tokens } : null,
        }
      } catch (error) {
        if (controller.signal.aborted) throw new Error('timeout')
        if (error instanceof LlmCallError) throw error
        throw new LlmCallError('LLM request failed', 'network')
      } finally {
        clearTimeout(timeout)
      }
    },
  }
}
