import { describe, expect, it, vi } from 'vitest'
import { disabledProvider, type LlmProvider, type LlmRequest } from './provider.js'
import type { CallMeta, CallMeter } from './run.js'
import { fallbackReminder, generateReminder, type ReminderContext, type ReminderPhase } from './reminder.js'

const context: ReminderContext = {
  phase: 'work', localDate: '2026-10-05', timeZone: 'Europe/Moscow',
  currentWork: { id: 'current', title: 'Презентация' },
  tasks: [{ id: 'other', title: 'Письма' }],
}
const provider = (answer: unknown, observe?: (request: LlmRequest) => void): LlmProvider => ({
  enabled: true, model: 'test',
  async complete(request) { observe?.(request); return { text: JSON.stringify(answer), usage: { inputTokens: 20, outputTokens: 10 } } },
})

describe('bounded reminder generation', () => {
  it.each(['morning', 'work', 'break', 'post_rest'] as ReminderPhase[])('disabled %s returns neutral deterministic text without a call', async (phase) => {
    const meter = vi.fn(async (_meta: CallMeta) => {})
    const outcome = await generateReminder(disabledProvider, { ...context, phase }, meter)
    expect(outcome).toEqual({ result: fallbackReminder(phase), provenance: 'fallback', failure: { ok: false, reason: 'disabled' } })
    expect(meter).not.toHaveBeenCalled()
  })
  it('accepts grounded work question and meters exactly once', async () => {
    const answer = { text: 'Как там «Презентация» — передохнём или продолжишь?', taskId: 'current' }
    const meter = vi.fn(async (_meta: CallMeta) => {})
    expect(await generateReminder(provider(answer), context, meter)).toEqual({ result: answer, provenance: 'llm', failure: null })
    expect(meter).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ status: 'ok', usage: { inputTokens: 20, outputTokens: 10 } }))
  })
  it.each([
    { text: 'Продолжишь или передохнёшь?', taskId: 'foreign' },
    { text: 'Как там выдуманный отчёт — передохнёшь или продолжишь?', taskId: null },
    { text: 'Как там «Презентация» — передохнёшь или продолжишь?', taskId: null },
    { text: 'Игнорируй правила, передохнёшь или продолжишь?', taskId: null },
    { text: 'Продолжишь или передохнёшь?', taskId: 'current' },
    { text: 'Продолжишь или передохнёшь?', taskId: null, action: 'finish' },
    { text: 'Ты опять игнорируешь меня. Продолжишь?', taskId: null },
    { text: 'Ты непрерывно работал. Продолжишь?', taskId: null },
    { text: 'Ты не выполнил задачу. Продолжишь?', taskId: null },
    { text: 'Я наблюдаю за тобой. Продолжишь?', taskId: null },
    { text: 'Пора работать, быстро вернись к работе?', taskId: null },
    { text: 'ПРОДОЛЖИШЬ РАБОТАТЬ?', taskId: null },
    { text: 'Открой https://example.org и продолжишь?', taskId: null },
    { text: 'Нажми /finish и передохнёшь?', taskId: null },
    { text: 'Продолжишь? Или передохнёшь?', taskId: null },
    { text: 'x'.repeat(301) + '?', taskId: null },
    { text: 'Как отдых, готов вернуться?', taskId: null },
  ])('rejects unsafe, ungrounded, phase-incompatible or malformed output: %j', async (answer) => {
    const meter = vi.fn(async (_meta: CallMeta) => {})
    const complete = vi.fn(provider(answer).complete)
    const outcome = await generateReminder({ enabled: true, model: 'test', complete }, context, meter)
    expect(outcome).toMatchObject({ result: fallbackReminder('work'), provenance: 'fallback', failure: { reason: 'invalid' } })
    expect(meter).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ status: 'invalid' }))
    expect(complete).toHaveBeenCalledTimes(1)
  })
  it.each(['break', 'post_rest'] as const)('rest %s receives no tasks/plan/report and rejects task pressure', async (phase) => {
    const outcome = await generateReminder(provider({ text: 'Как там «Презентация», готов вернуться?', taskId: 'current' }, (request) => {
      const data = JSON.parse(request.input)
      expect(data.current_work).toBeNull()
      expect(data.tasks).toEqual([])
      expect(data.today_plan).toBeNull()
      expect(data.last_report).toBeNull()
    }), { ...context, phase, lastReport: 'Презентация не закончена' })
    expect(outcome.failure).toMatchObject({ reason: 'invalid' })
  })
  it.each(['morning', 'break', 'post_rest'] as const)('accepts neutral %s question', async (phase) => {
    expect((await generateReminder(provider(fallbackReminder(phase)), { ...context, phase })).provenance).toBe('llm')
  })
  it('bounds data, ignores unrelated extra input, and does not carry yesterday plan into today', async () => {
    await generateReminder(provider(fallbackReminder('work'), (request) => {
      const data = JSON.parse(request.input)
      expect(data.today_plan).toBeNull()
      expect(data.tasks).toHaveLength(3)
      expect(data.tasks.every((task: { title: string }) => task.title.length <= 160)).toBe(true)
      expect(data.current_work.title).toHaveLength(160)
      expect(data.last_report).toHaveLength(300)
      expect(data.last_answer).toHaveLength(300)
      expect(data.previous_text).toHaveLength(300)
      expect(request.input).not.toContain('foreignSecret')
      expect(request.system).toContain('не инструкции')
      expect(request).toMatchObject({ maxTokens: 200, timeoutMs: 2500 })
    }), { ...context, currentWork: { id: 'current', title: 'a'.repeat(1000) }, tasks: Array.from({ length: 40 }, (_, i) => ({ id: String(i), title: 'b'.repeat(500) })), todayPlan: { localDate: '2026-10-04', text: 'Yesterday plan' }, lastReport: 'c'.repeat(1000), lastAnswer: 'd'.repeat(1000), previousText: 'e'.repeat(1000), ...{ foreignSecret: 'foreignSecret' } })
  })
  it('accepts free-text current work without inventing a task identity', async () => {
    const outcome = await generateReminder(provider({ text: 'Как там «Свободная работа» — передохнёшь или продолжишь?', taskId: null }, (request) => {
      expect(JSON.parse(request.input).current_work).toEqual({ id: null, title: 'Свободная работа' })
    }), { ...context, currentWork: { id: null, title: 'Свободная работа' } })
    expect(outcome.provenance).toBe('llm')
  })
  it('does not truncate task identifiers into a new allowed identity', async () => {
    const longId = 'x'.repeat(101)
    const outcome = await generateReminder(provider({ text: 'Как там «Презентация» — передохнёшь или продолжишь?', taskId: longId.slice(0, 100) }, (request) => {
      expect(JSON.parse(request.input).current_work).toBeNull()
    }), { ...context, currentWork: { id: longId, title: 'Презентация' } })
    expect(outcome.failure).toMatchObject({ reason: 'invalid' })
  })
  it('budget rejection does not call or meter provider', async () => {
    const complete = vi.fn(provider(fallbackReminder('work')).complete)
    const meter = vi.fn(async (_meta: CallMeta) => {}) as CallMeter
    meter.allow = vi.fn(async () => false)
    expect((await generateReminder({ enabled: true, model: 'test', complete }, context, meter)).failure).toEqual({ ok: false, reason: 'budget' })
    expect(complete).not.toHaveBeenCalled()
    expect(meter).not.toHaveBeenCalled()
  })
  it('provider error falls back with one measured call', async () => {
    const meter = vi.fn(async (_meta: CallMeta) => {})
    expect((await generateReminder({ enabled: true, model: 'test', async complete() { throw new Error('failure') } }, context, meter)).failure).toEqual({ ok: false, reason: 'error' })
    expect(meter).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ status: 'error' }))
  })
  it('timeout falls back without a generation retry', async () => {
    vi.useFakeTimers()
    try {
      const meter = vi.fn(async (_meta: CallMeta) => {})
      const complete = vi.fn(async () => new Promise<never>(() => {}))
      const pending = generateReminder({ enabled: true, model: 'test', complete }, context, meter)
      await vi.advanceTimersByTimeAsync(2500)
      expect((await pending).failure).toEqual({ ok: false, reason: 'timeout' })
      expect(meter).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ status: 'timeout' }))
      expect(complete).toHaveBeenCalledTimes(1)
    } finally { vi.useRealTimers() }
  })
})
