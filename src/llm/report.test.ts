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


describe('распределение требует основания в тексте', () => {
  it.each(['Начинаю делать фокус-бот.', 'Поработал над ботом', 'Мне ещё нужно 15 минут на бота'])(
    'не доверяет придуманному остатку или минутам: %s', async (report) => {
      const parsed = await parseReport(provider(JSON.stringify({ progress: 'moved', next_step: null,
        allocations: [{ task: 't1', title: 'Бот', minutes: null, remainder: true, source: report }],
      })), { intent: 'Бот', outcome: 'not_done', report })
      expect(parsed.result.allocations).toEqual([])
    },
  )

  it('отбрасывает минутную разбивку без цитаты и с выдуманным числом', async () => {
    for (const source of [undefined, '15 минут на бота', 'нет такой цитаты']) {
      const parsed = await parseReport(provider(JSON.stringify({ progress: 'moved', next_step: null,
        allocations: [{ task: 't1', title: 'Бот', minutes: 40, remainder: false, ...(source ? { source } : {}) }],
      })), { intent: 'Бот', outcome: 'done', report: '15 минут на бота' })
      expect(parsed.result.allocations).toEqual([])
    }
  })
})


describe('смысл важнее ожидания отчёта', () => {
  it.each(['new_action', 'unclear'])('не применяет report-поля для %s', async (route) => {
    const parsed = await parseReport(provider(JSON.stringify({ route, progress: 'moved', next_step: 'Бот', continue_now: true,
      allocations: [{ task: 't1', title: 'Бот', minutes: 15, remainder: false, source: '15 минут на бота' }],
    })), { intent: 'Бот', outcome: 'done', report: '15 минут на бота' })
    expect(parsed.result).toMatchObject({ route, progress: null, nextStep: null, continueNow: false, allocations: [] })
  })

  it('принимает только реально названные прошлые минуты и остаток', async () => {
    const parsed = await parseReport(provider(JSON.stringify({ route: 'report', progress: null, next_step: null,
      allocations: [
        { task: 't1', title: 'Бот', minutes: 15, remainder: false, source: 'пятнадцать минут на бота' },
        { task: 't2', title: 'Почта', minutes: null, remainder: true, source: 'остальное на почту' },
      ],
    })), { intent: 'Бот', outcome: 'done', report: 'пятнадцать минут на бота, остальное на почту', tasks: [{ label: 't1', title: 'Бот' }, { label: 't2', title: 'Почта' }] })
    expect(parsed.result.allocations).toHaveLength(2)
    expect(parsed.result.progress).toBeNull()
  })

  it('не распределяет явно будущие минуты даже с точной цитатой', async () => {
    const parsed = await parseReport(provider(JSON.stringify({ progress: 'stuck', next_step: null,
      allocations: [{ task: 't1', title: 'Бот', minutes: 15, remainder: false, source: 'Мне ещё нужно 15 минут на бота' }],
    })), { intent: 'Бот', outcome: 'not_done', report: 'Мне ещё нужно 15 минут на бота' })
    expect(parsed.result.allocations).toEqual([])
  })
})


describe('цитата не может скрывать контекст или подменять задачу', () => {
  it.each([
    ['Хочу поработать 15 минут над ботом', '15 минут над ботом', 'Бот'],
    ['Мне нужно 15 минут на бота', '15 минут на бота', 'Бот'],
    ['15 минут ушло на почту', '15 минут', 'Бот'],
    ['15 минут ушло на почту', '15 минут ушло на почту', 'Бот'],
  ])('не применяет %s', async (report, source, title) => {
    const parsed = await parseReport(provider(JSON.stringify({ progress: 'moved', next_step: null,
      allocations: [{ task: 't1', title, minutes: 15, remainder: false, source }],
    })), { intent: title, outcome: 'done', report, tasks: [{ label: 't1', title }] })
    expect(parsed.result.allocations).toEqual([])
  })
})
