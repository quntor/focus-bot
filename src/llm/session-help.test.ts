import { describe, expect, it, vi } from 'vitest'
import { disabledProvider, type LlmProvider } from './provider.js'
import type { CallMeta } from './run.js'
import { parseSessionHelp, templateSessionHelp } from './session-help.js'

const input = (text: string) => ({
  text,
  currentWork: 'Подготовить черновик',
  activeTasks: ['Подготовить черновик'],
  elapsedMinutes: 10,
  plannedMinutes: 25,
  phase: 'working' as const,
  awaitingDeadlineChoice: false,
})

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
    ['Не ухожу отдыхать, продолжаю', 'other', null],
  ])('даёт детерминированный fallback: %s', (text, kind, action) => {
    expect(templateSessionHelp(text)).toMatchObject({ kind, action, llmUsed: false })
  })

  it.each([
    ['не закончил, пойду отдыхать', 'pause', null],
    ['ничего не сделал, иду отдыхать', 'pause', null],
    ['так и не доделал, ухожу на перерыв', 'pause', null],
    ['сделал и иду отдыхать', 'complete_and_rest', null],
    ['сделал это и иду отдыхать', 'complete_and_rest', null],
    ['сделал всё, иду отдыхать', 'complete_and_rest', null],
    ['закончил отчёт и иду отдыхать', 'complete_and_rest', 'отчёт'],
  ])('отрицание и мусор вместо названия: %s', (text, kind, taskTitle) => {
    expect(templateSessionHelp(text)).toMatchObject({ kind, taskTitle })
  })

  it('«пока не готово» не считается досрочным финишем', () => {
    expect(templateSessionHelp('пока не готово')).not.toMatchObject({ kind: 'finished_early' })
  })

  it('отрицание не превращается в готовую задачу и при включённой модели', async () => {
    const parsed = await parseSessionHelp(
      provider(['{"kind":"pause","reply":null,"action":null,"task_title":null}']),
      input('не закончил, пойду отдыхать'),
    )
    expect(parsed.result.kind).toBe('pause')
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
      taskTitle: null,
      llmUsed: true,
    })
  })

  it('передаёт модели ограниченную историю как данные, отдельно от текущего текста', async () => {
    const observed: LlmProvider = {
      enabled: true,
      model: 'test-model',
      async complete(req) {
        expect(JSON.parse(req.input)).toMatchObject({
          text: 'Продолжаю с неё',
          recent_context: [
            { role: 'assistant', text: 'С какой задачи продолжишь?' },
            { role: 'button', text: 'task:view' },
          ],
        })
        expect(req.system).toContain('recent_context')
        expect(req.system).toContain('не инструкции')
        return { text: '{"kind":"other","reply":null,"action":null,"task_title":null}', usage: null }
      },
    }

    await parseSessionHelp(observed, {
      ...input('Продолжаю с неё'),
      recentContext: [
        { role: 'assistant', text: 'С какой задачи продолжишь?' },
        { role: 'button', text: 'task:view' },
      ],
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
