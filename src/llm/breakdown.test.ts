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
    expect(await breakDownTask(answering(text), { title: 'Курсовая', answer: null, recentContext: [] })).toMatchObject({ ok: false, reason: 'invalid' })
  })

  it.each([
    ['шаги и вопрос сразу', JSON.stringify({ steps: ['Открыть'], question: 'Что в итоге?' })],
    ['вопрос длиннее 160 символов', JSON.stringify({ question: 'а'.repeat(161) })],
  ])('%s — отказ', async (_name, text) => {
    expect(await breakDownTask(answering(text), { title: 'Курсовая', answer: null, recentContext: [] })).toMatchObject({ ok: false, reason: 'invalid' })
  })

  it('размытая задача — вопрос вместо шагов', async () => {
    expect(await breakDownTask(answering(JSON.stringify({ question: 'Что должно получиться в итоге?' })), { title: 'Разобраться с жизнью', answer: null, recentContext: [] }))
      .toEqual({ ok: true, value: { kind: 'question', question: 'Что должно получиться в итоге?' } })
  })

  it('выключенная модель не вызывается', async () => {
    const off: LlmProvider = { enabled: false, model: null, async complete() { throw new Error('не должно вызываться') } }
    expect(await breakDownTask(off, { title: 'Курсовая', answer: 'с плана', recentContext: [] })).toEqual({ ok: false, reason: 'disabled' })
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
