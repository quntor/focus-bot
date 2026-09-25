export type SttRequest = {
  audio: Uint8Array
  filename: string
  mimeType: string
  timeoutMs: number
}

export interface SttProvider {
  readonly enabled: boolean
  transcribe(req: SttRequest): Promise<string>
}

export const disabledSttProvider: SttProvider = {
  enabled: false,
  async transcribe() {
    throw new Error('STT disabled')
  },
}
