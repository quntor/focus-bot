export type SttRequest = {
  audio: Uint8Array
  filename: string
  mimeType: string
  timeoutMs: number
}

export interface SttProvider {
  readonly enabled: boolean
  readonly model: string | null
  transcribe(req: SttRequest): Promise<string>
}

export class SttCallError extends Error {
  override name = 'SttCallError'
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message)
  }
}

export const disabledSttProvider: SttProvider = {
  enabled: false,
  model: null,
  async transcribe() {
    throw new Error('STT disabled')
  },
}
