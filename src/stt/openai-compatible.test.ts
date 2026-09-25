import { describe, expect, it, vi } from 'vitest'
import { createOpenAiCompatibleSttProvider } from './openai-compatible.js'

describe('OpenAI-compatible STT', () => {
  it('отправляет аудио multipart-запросом на transcription endpoint', async () => {
    const fetchFn = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const form = init?.body as FormData
      expect(form.get('model')).toBe('openai/whisper-large-v3')
      expect(form.get('file')).toBeInstanceOf(File)
      return new Response(JSON.stringify({ text: 'добавь задачу купить корм' }), { status: 200 })
    })
    const stt = createOpenAiCompatibleSttProvider({
      apiKey: 'secret',
      baseUrl: 'https://foundation-models.example/v1',
      model: 'openai/whisper-large-v3',
      fetchFn,
    })

    await expect(
      stt.transcribe({ audio: new Uint8Array([1, 2, 3]), filename: 'voice.ogg', mimeType: 'audio/ogg', timeoutMs: 1_000 }),
    ).resolves.toBe('добавь задачу купить корм')
    expect(fetchFn).toHaveBeenCalledWith(
      'https://foundation-models.example/v1/audio/transcriptions',
      expect.objectContaining({ method: 'POST', headers: { authorization: 'Bearer secret' } }),
    )
  })

  it('не пробрасывает тело ошибки провайдера', async () => {
    const stt = createOpenAiCompatibleSttProvider({
      apiKey: 'secret',
      baseUrl: 'https://foundation-models.example/v1',
      model: 'openai/whisper-large-v3',
      fetchFn: async () => new Response('user audio reflected here', { status: 422 }),
    })

    await expect(
      stt.transcribe({ audio: new Uint8Array([1]), filename: 'voice.ogg', mimeType: 'audio/ogg', timeoutMs: 1_000 }),
    ).rejects.not.toThrow('user audio reflected here')
  })
})
