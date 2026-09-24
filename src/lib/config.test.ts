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
      LLM_API_KEY: 'cloud-key',
      LLM_BASE_URL: 'https://foundation-models.api.cloud.ru/v1',
      LLM_MODEL: 'ai-sage/GigaChat3-10B-A1.8B',
    })
    expect(config.LLM_MODEL).toBe('ai-sage/GigaChat3-10B-A1.8B')
  })

  it('отклоняет неполный набор, не печатая ключ', () => {
    expect(() => parseConfig({ ...base, LLM_API_KEY: 'cloud-key' })).toThrow('LLM_BASE_URL, LLM_MODEL')
    expect(() => parseConfig({ ...base, LLM_API_KEY: 'cloud-key' })).not.toThrow('cloud-key')
  })

  it('требует HTTPS для адреса модели', () => {
    expect(() =>
      parseConfig({ ...base, LLM_API_KEY: 'cloud-key', LLM_BASE_URL: 'http://example.test/v1', LLM_MODEL: 'model' }),
    ).toThrow('LLM_BASE_URL')
  })
})
