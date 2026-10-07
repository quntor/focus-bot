import { describe, expect, it } from 'vitest'
import { parseConfig } from './config.js'

const base = {
  TELEGRAM_BOT_TOKEN: 'telegram-token',
  TELEGRAM_WEBHOOK_SECRET: 's'.repeat(32),
  TELEGRAM_WEBHOOK_PATH: 'p'.repeat(32),
  DATABASE_URL: 'postgresql://focus:focus@db:5432/focus',
}

describe('LLM config', () => {
  it('regular reminder activation requires explicit flag and allowlist',()=>{
    expect(parseConfig(base).REMINDERS_ENABLED).toBe(false)
    expect(parseConfig(base).REMINDER_USER_IDS).toEqual([])
    expect(parseConfig({...base,REMINDERS_ENABLED:'true',REMINDER_USER_IDS:'12, 34'})).toMatchObject({REMINDERS_ENABLED:true,REMINDER_USER_IDS:['12','34']})
    expect(()=>parseConfig({...base,REMINDERS_ENABLED:'0'})).toThrow('REMINDERS_ENABLED')
    expect(()=>parseConfig({...base,REMINDER_USER_IDS:'12,not-an-id'})).toThrow('REMINDER_USER_IDS')
  })

  it('routing flag is explicit, default off, false is a real kill switch', () => {
    expect(parseConfig(base).SEMANTIC_ROUTER_ENABLED).toBe(true)
    expect(parseConfig({ ...base, SEMANTIC_ROUTER_ENABLED: 'false' }).SEMANTIC_ROUTER_ENABLED).toBe(true)
    expect(parseConfig({ ...base, SEMANTIC_ROUTER_ENABLED: 'true' }).SEMANTIC_ROUTER_ENABLED).toBe(true)
    expect(() => parseConfig({ ...base, SEMANTIC_ROUTER_ENABLED: '0' })).toThrow('SEMANTIC_ROUTER_ENABLED')
  })

  it('отключает provider при пустом наборе LLM_*', () => {
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
