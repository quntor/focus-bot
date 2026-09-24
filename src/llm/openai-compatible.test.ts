import { describe, expect, it, vi } from 'vitest'
import { createOpenAiCompatibleProvider } from './openai-compatible.js'

const request = {
  system: 'Верни только JSON.',
  input: '{"intent":"написать план"}',
  maxTokens: 200,
  timeoutMs: 8_000,
}

describe('OpenAI-compatible provider', () => {
  it('отправляет системный промт и вход на chat/completions', async () => {
    const fetchFn = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
    const provider = createOpenAiCompatibleProvider({
      apiKey: 'test-secret',
      baseUrl: 'https://foundation-models.api.cloud.ru/v1',
      model: 'ai-sage/GigaChat3-10B-A1.8B',
      fetchFn,
    })

    await expect(provider.complete(request)).resolves.toEqual({ text: '{"ok":true}', usage: null })
    expect(fetchFn).toHaveBeenCalledOnce()
    const [url, init] = fetchFn.mock.calls[0]!
    expect(url).toBe('https://foundation-models.api.cloud.ru/v1/chat/completions')
    expect(init?.headers).toEqual({
      authorization: 'Bearer test-secret',
      'content-type': 'application/json',
    })
    expect(JSON.parse(String(init?.body))).toEqual({
      model: 'ai-sage/GigaChat3-10B-A1.8B',
      max_tokens: 200,
      temperature: 0,
      messages: [
        { role: 'system', content: request.system },
        { role: 'user', content: request.input },
      ],
    })
  })

  it('не включает тело ошибки провайдера в исключение', async () => {
    const fetchFn = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      new Response('sensitive provider response', { status: 402 }),
    )
    const provider = createOpenAiCompatibleProvider({
      apiKey: 'test-secret',
      baseUrl: 'https://foundation-models.api.cloud.ru/v1/',
      model: 'model',
      fetchFn,
    })

    await expect(provider.complete(request)).rejects.toThrow('LLM request failed (HTTP 402)')
    await expect(provider.complete(request)).rejects.not.toThrow('sensitive provider response')
  })

  it('отклоняет ответ без текстового choices[0].message.content', async () => {
    const fetchFn = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify({ choices: [] }), { status: 200 }),
    )
    const provider = createOpenAiCompatibleProvider({
      apiKey: 'test-secret',
      baseUrl: 'https://foundation-models.api.cloud.ru/v1',
      model: 'model',
      fetchFn,
    })

    await expect(provider.complete(request)).rejects.toThrow('Invalid LLM response')
  })

  it('прерывает зависший запрос по таймауту касания', async () => {
    const fetchFn = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
        }),
    )
    const provider = createOpenAiCompatibleProvider({
      apiKey: 'test-secret',
      baseUrl: 'https://foundation-models.api.cloud.ru/v1',
      model: 'model',
      fetchFn,
    })

    await expect(provider.complete({ ...request, timeoutMs: 10 })).rejects.toThrow('timeout')
  })
})
