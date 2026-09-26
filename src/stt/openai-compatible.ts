import { z } from 'zod'
import { SttCallError, type SttProvider, type SttRequest } from './provider.js'

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

type Options = {
  apiKey: string
  baseUrl: string
  model: string
  fetchFn?: FetchLike
}

const responseSchema = z.object({ text: z.string().min(1).max(20_000) })
const TRANSCRIPTION_PROMPT = 'Милавица, VDS, FocusBot, фокус-бот, планирование дня.'

export function createOpenAiCompatibleSttProvider(options: Options): SttProvider {
  const fetchFn = options.fetchFn ?? fetch
  const url = `${options.baseUrl.replace(/\/+$/, '')}/audio/transcriptions`

  return {
    enabled: true,
    model: options.model,
    async transcribe(req: SttRequest): Promise<string> {
      const form = new FormData()
      form.append('model', options.model)
      form.append('language', 'ru')
      form.append('prompt', TRANSCRIPTION_PROMPT)
      const audioBuffer = new ArrayBuffer(req.audio.byteLength)
      new Uint8Array(audioBuffer).set(req.audio)
      form.append('file', new File([audioBuffer], req.filename, { type: req.mimeType }))

      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), req.timeoutMs)
      try {
        const response = await fetchFn(url, {
          method: 'POST',
          headers: { authorization: `Bearer ${options.apiKey}` },
          body: form,
          signal: controller.signal,
        })
        if (!response.ok) throw new SttCallError(`STT request failed (HTTP ${response.status})`, `http_${response.status}`)

        let body: unknown
        try {
          body = await response.json()
        } catch {
          throw new SttCallError('Invalid STT response', 'bad_response')
        }
        const parsed = responseSchema.safeParse(body)
        if (!parsed.success) throw new SttCallError('Invalid STT response', 'bad_response')
        return parsed.data.text.trim()
      } catch (error) {
        if (controller.signal.aborted) throw new SttCallError('STT request timed out', 'timeout')
        if (error instanceof SttCallError) throw error
        throw new SttCallError('STT request failed', 'network')
      } finally {
        clearTimeout(timeout)
      }
    },
  }
}
