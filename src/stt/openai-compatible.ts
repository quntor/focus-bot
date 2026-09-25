import { z } from 'zod'
import type { SttProvider, SttRequest } from './provider.js'

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

type Options = {
  apiKey: string
  baseUrl: string
  model: string
  fetchFn?: FetchLike
}

const responseSchema = z.object({ text: z.string().min(1).max(20_000) })

class SafeSttError extends Error {}

export function createOpenAiCompatibleSttProvider(options: Options): SttProvider {
  const fetchFn = options.fetchFn ?? fetch
  const url = `${options.baseUrl.replace(/\/+$/, '')}/audio/transcriptions`

  return {
    enabled: true,
    async transcribe(req: SttRequest): Promise<string> {
      const form = new FormData()
      form.append('model', options.model)
      form.append('language', 'ru')
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
        if (!response.ok) throw new SafeSttError(`STT request failed (HTTP ${response.status})`)

        let body: unknown
        try {
          body = await response.json()
        } catch {
          throw new SafeSttError('Invalid STT response')
        }
        const parsed = responseSchema.safeParse(body)
        if (!parsed.success) throw new SafeSttError('Invalid STT response')
        return parsed.data.text.trim()
      } catch (error) {
        if (controller.signal.aborted) throw new Error('timeout')
        if (error instanceof SafeSttError) throw error
        throw new Error('STT request failed')
      } finally {
        clearTimeout(timeout)
      }
    },
  }
}
