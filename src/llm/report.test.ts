import { describe, expect, it } from 'vitest'
import type { LlmProvider } from './provider.js'
import { parseReport } from './report.js'

const provider = (text: string): LlmProvider => ({
  enabled: true,
  model: 'test-model',
  async complete() {
    return { text, usage: null }
  },
})

describe('разбор продолжения в отчёте', () => {
  it('возвращает только предложение продолжить, не побочный эффект', async () => {
    const parsed = await parseReport(
      provider('{"progress":"stuck","next_step":"продолжить проверку","continue_now":true,"allocations":[]}'),
      { intent: 'Мониторинг', outcome: 'not_done', report: 'Не хватило времени, продолжаю работу' },
    )
    expect(parsed.result.continueNow).toBe(true)
  })

  it('старый ответ модели без поля совместим и не запускает продолжение', async () => {
    const parsed = await parseReport(
      provider('{"progress":"stuck","next_step":null,"allocations":[]}'),
      { intent: 'Мониторинг', outcome: 'not_done', report: 'Продолжу завтра' },
    )
    expect(parsed.result.continueNow).toBe(false)
  })
})
