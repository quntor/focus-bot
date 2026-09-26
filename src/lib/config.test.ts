import { describe, expect, it } from 'vitest'
import { parseConfig } from './config.js'

const base = {
  TELEGRAM_BOT_TOKEN: 'telegram-token',
  TELEGRAM_WEBHOOK_SECRET: 's'.repeat(32),
  TELEGRAM_WEBHOOK_PATH: 'p'.repeat(32),
  DATABASE_URL: 'postgresql://focus:focus@db:5432/focus',
}

describe('LLM config', () => {
  it('сохраняет детерминированный режим при пустом наборе LLM_*', () => {
    const config = parseConfig({ ...base, LLM_API_KEY: '', LLM_BASE_URL: '', LLM_MODEL: '' })
    expect(config.LLM_API_KEY).toBeUndefined()
    expect(config.LLM_BASE_URL).toBeUndefined()
    expect(config.LLM_MODEL).toBeUndefined()
  })

  it('принимает полный OpenAI-compatible набор', () => {
    const config = parseConfig({
      ...base,
      LLM_API_KEY: 'sber-token',
      LLM_BASE_URL: 'https://shared1.multitool.works:4000/v1',
      LLM_MODEL: 'gigachat3-10b-a1.8b',
    })
    expect(config.LLM_MODEL).toBe('gigachat3-10b-a1.8b')
  })

  it('включает STT отдельно на тех же credentials', () => {
    const config = parseConfig({
      ...base,
      LLM_API_KEY: 'sber-token',
      LLM_BASE_URL: 'https://shared1.multitool.works:4000/v1',
      LLM_MODEL: 'gigachat3-10b-a1.8b',
      STT_MODEL: 'whisper-large-v3',
    })
    expect(config.STT_MODEL).toBe('whisper-large-v3')
  })

  it('не включает STT без credentials', () => {
    expect(() => parseConfig({ ...base, STT_MODEL: 'whisper-large-v3' })).toThrow('STT_MODEL')
  })

  it('отклоняет неполный набор, не печатая ключ', () => {
    expect(() => parseConfig({ ...base, LLM_API_KEY: 'sber-token' })).toThrow('LLM_BASE_URL, LLM_MODEL')
    expect(() => parseConfig({ ...base, LLM_API_KEY: 'sber-token' })).not.toThrow('sber-token')
  })

  it('требует HTTPS для адреса модели', () => {
    expect(() =>
      parseConfig({ ...base, LLM_API_KEY: 'sber-token', LLM_BASE_URL: 'http://example.test/v1', LLM_MODEL: 'model' }),
    ).toThrow('LLM_BASE_URL')
  })
})
