import { describe, expect, it } from 'vitest'
import type { LlmProvider } from './provider.js'
import { breakDownTask, splitManualSteps } from './breakdown.js'

const answering = (text: string): LlmProvider => ({ enabled: true, model: 'test-model', async complete() { return { text, usage: null } } })

describe('разбор задачи: строгая схема ответа модели', () => {
  it.each([
    ['лишнее поле', JSON.stringify({ steps: ['Открыть черновик'], points: 1000 })],
    ['больше шести шагов', JSON.stringify({ steps: ['1', '2', '3', '4', '5', '6', '7'] })],
    ['пустой список', JSON.stringify({ steps: [] })],
    ['шаг длиннее 80 символов', JSON.stringify({ steps: ['а'.repeat(81)] })],
    ['не JSON', 'Вот шаги: 1) открыть'],
  ])('%s — отказ и детерминированный путь', async (_name, text) => {
    expect(await breakDownTask(answering(text), { title: 'Курсовая', answer: null })).toMatchObject({ ok: false, reason: 'invalid' })
  })

  it('выключенная модель не вызывается', async () => {
    const off: LlmProvider = { enabled: false, model: null, async complete() { throw new Error('не должно вызываться') } }
    expect(await breakDownTask(off, { title: 'Курсовая', answer: 'с плана' })).toEqual({ ok: false, reason: 'disabled' })
  })

  it('ручные шаги: строки, «;», нумерация и маркеры', () => {
    expect(splitManualSteps('1. Выбрать тему\n2) Найти источники; - Написать план\n\n• Показать')).toEqual([
      'Выбрать тему',
      'Найти источники',
      'Написать план',
      'Показать',
    ])
  })
})
