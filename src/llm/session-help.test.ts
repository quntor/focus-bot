import { describe, expect, it, vi } from 'vitest'
import { disabledProvider, type LlmProvider } from './provider.js'
import type { CallMeta } from './run.js'
import { parseSessionHelp, templateSessionHelp } from './session-help.js'

const input = (text: string) => ({ text, currentWork: 'Подготовить черновик', minutesLeft: 15 })

const provider = (answers: string[]): LlmProvider => ({
  enabled: true,
  model: 'test-model',
  async complete() {
    return { text: answers.shift() ?? 'мусор', usage: null }
  },
})

describe('помощь во время активной сессии', () => {
  it.each([
    ['Опять отвлёкся на уведомления', 'distracted', 'continue'],
    ['Застрял и не понимаю следующий шаг', 'stuck', 'change_step'],
    ['Готово, закончил раньше', 'finished_early', 'finish'],
    ['Как лучше начать этот абзац?', 'question', 'continue'],
    ['Добавь задачу купить бумагу', 'other', null],
  ])('даёт детерминированный fallback: %s', (text, kind, action) => {
    expect(templateSessionHelp(text)).toMatchObject({ kind, action, llmUsed: false })
  })

  it('принимает только короткий ответ и действие из закрытого списка', async () => {
    const parsed = await parseSessionHelp(
      provider(['{"kind":"stuck","reply":"Сузь задачу до одного проверяемого шага.","action":"change_step"}']),
      input('Хожу по кругу и не вижу следующего хода'),
    )

    expect(parsed.failure).toBeNull()
    expect(parsed.result).toEqual({
      kind: 'stuck',
      reply: 'Сузь задачу до одного проверяемого шага.',
      action: 'change_step',
      llmUsed: true,
    })
  })

  it('отбрасывает несовместимое действие, повторяет один раз и уходит в fallback', async () => {
    const meter = vi.fn(async (_meta: CallMeta) => {})
    const parsed = await parseSessionHelp(
      provider([
        '{"kind":"finished_early","reply":"Готово.","action":"continue"}',
        '{"kind":"finished_early","reply":"Готово.","action":"continue"}',
      ]),
      input('Готово, закончил раньше'),
      meter,
    )

    expect(parsed.result).toMatchObject({ kind: 'finished_early', action: 'finish', llmUsed: false })
    expect(parsed.failure).toMatchObject({ ok: false, reason: 'invalid' })
    expect(meter).toHaveBeenCalledTimes(2)
  })

  it('без модели сохраняет рабочий fallback', async () => {
    const parsed = await parseSessionHelp(disabledProvider, input('Не вижу следующего хода'))

    expect(parsed.result).toMatchObject({ kind: 'stuck', action: 'change_step', llmUsed: false })
    expect(parsed.failure).toMatchObject({ ok: false, reason: 'disabled' })
  })
})
