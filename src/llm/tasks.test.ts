import { describe, expect, it } from 'vitest'
import type { LlmProvider } from './provider.js'
import { parseTaskMessage } from './tasks.js'

const provider = (content: string): LlmProvider => ({
  enabled: true,
  async complete() {
    return content
  },
})

const tasks = [
  { id: 'own-a', title: 'Подготовить презентацию' },
  { id: 'own-b', title: 'Позвонить Ивану' },
]

describe('разбор сообщения со списком задач', () => {
  it('извлекает несколько новых задач', async () => {
    const parsed = await parseTaskMessage(
      provider('{"kind":"capture","tasks":["Подготовить отчёт","Купить корм"],"complete_task":null,"start_task":null,"start_title":null}'),
      { text: 'Сегодня хочу подготовить отчёт и купить корм', tasks, currentTaskId: null },
    )

    expect(parsed.failure).toBeNull()
    expect(parsed.result).toEqual({ kind: 'capture', titles: ['Подготовить отчёт', 'Купить корм'], llmUsed: true })
  })

  it('принимает capture без опущенных моделью null-полей', async () => {
    const parsed = await parseTaskMessage(
      provider('{"kind":"capture","tasks":["Доделать выкат","Поправить ошибки"]}'),
      { text: 'Нужно доделать выкат и поправить ошибки', tasks, currentTaskId: null },
    )

    expect(parsed.failure).toBeNull()
    expect(parsed.result).toEqual({ kind: 'capture', titles: ['Доделать выкат', 'Поправить ошибки'], llmUsed: true })
  })

  it('переводит только временные метки своих задач в id', async () => {
    const parsed = await parseTaskMessage(
      provider('{"kind":"complete_and_start","tasks":[],"complete_task":"t1","start_task":"t2","start_title":null}'),
      { text: 'Первую сделал, перехожу ко второй', tasks, currentTaskId: 'own-a' },
    )

    expect(parsed.failure).toBeNull()
    expect(parsed.result).toEqual({
      kind: 'complete_and_start',
      completeTaskId: 'own-a',
      start: { taskId: 'own-b', title: 'Позвонить Ивану' },
      llmUsed: true,
    })
  })

  it('отвергает выдуманную метку без частичного действия', async () => {
    const parsed = await parseTaskMessage(
      provider('{"kind":"complete_and_start","tasks":[],"complete_task":"t99","start_task":null,"start_title":"Новая задача"}'),
      { text: 'Сделал старую, начинаю новую', tasks, currentTaskId: 'own-a' },
    )

    expect(parsed.result).toBeNull()
    expect(parsed.failure).toMatchObject({ ok: false, reason: 'invalid' })
  })

  it('возвращает обычное намерение без операций с задачами', async () => {
    const parsed = await parseTaskMessage(
      provider('{"kind":"session_intent","tasks":[],"complete_task":null,"start_task":null,"start_title":null}'),
      { text: 'Поработаю над презентацией', tasks, currentTaskId: null },
    )

    expect(parsed.result).toEqual({ kind: 'session_intent', llmUsed: true })
  })
})
