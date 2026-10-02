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

  it('отделяет длительность будущего захода от распределения уже отработанного времени', async () => {
    const parsed = await parseReport(
      provider('{"progress":"stuck","next_step":"поправить косяки","continue_now":true,"continue_minutes":15,"allocations":[]}'),
      {
        intent: 'Раздельное сканирование марок в Милавице',
        outcome: 'not_done',
        report: 'Мне ещё нужно 15 минут поправить косяки',
      },
    )

    expect(parsed.result).toMatchObject({
      nextStep: 'поправить косяки',
      continueNow: true,
      continueMinutes: 15,
      allocations: [],
    })
  })
})
