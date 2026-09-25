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
      provider('{"kind":"capture","new_tasks":["Подготовить отчёт","Купить корм"],"complete_task":null,"start_task":null,"start_title":null}'),
      { text: 'Сегодня хочу подготовить отчёт и купить корм', tasks, currentTaskId: null },
    )

    expect(parsed.failure).toBeNull()
    expect(parsed.result).toEqual({ kind: 'capture', titles: ['Подготовить отчёт', 'Купить корм'], llmUsed: true })
  })

  it('принимает capture без опущенных моделью null-полей', async () => {
    const parsed = await parseTaskMessage(
      provider('{"kind":"capture","new_tasks":["Доделать выкат","Поправить ошибки"]}'),
      { text: 'Нужно доделать выкат и поправить ошибки', tasks, currentTaskId: null },
    )

    expect(parsed.failure).toBeNull()
    expect(parsed.result).toEqual({ kind: 'capture', titles: ['Доделать выкат', 'Поправить ошибки'], llmUsed: true })
  })

  it('разделяет активные задачи во входе и новые задачи в ответе', async () => {
    const observed: LlmProvider = {
      enabled: true,
      async complete(req) {
        expect(JSON.parse(req.input)).toEqual({
          text: 'Нужно доделать выкат и поправить ошибки',
          active_tasks: [
            { label: 't1', title: 'Подготовить презентацию' },
            { label: 't2', title: 'Позвонить Ивану' },
          ],
          current_task: null,
        })
        expect(req.system).toContain('new_tasks')
        return '{"kind":"capture","new_tasks":["Доделать выкат","Поправить ошибки"]}'
      },
    }
    const parsed = await parseTaskMessage(observed, {
      text: 'Нужно доделать выкат и поправить ошибки',
      tasks,
      currentTaskId: null,
    })

    expect(parsed.failure).toBeNull()
    expect(parsed.result).toEqual({ kind: 'capture', titles: ['Доделать выкат', 'Поправить ошибки'], llmUsed: true })
  })

  it('сохраняет самостоятельные действия и объединяет близкие переформулировки', async () => {
    const qualityAware: LlmProvider = {
      enabled: true,
      async complete(req) {
        const hasCoverageRule = req.system.includes('каждое явно названное самостоятельное действие')
        const hasDedupeRule = req.system.includes('Фрагмент без личной формы глагола')
        return hasCoverageRule && hasDedupeRule
          ? JSON.stringify({
              kind: 'capture',
              new_tasks: [
                'Доделать выкат Милавицы на VDS',
                'Поправить все косяки',
                'Запустить умные функции FocusBot',
                'Сделать планирование дня',
                'Сделать функцию планирования дня',
              ],
            })
          : JSON.stringify({
              kind: 'capture',
              new_tasks: [
                'Доделать выкат Милавицы на VDS',
                'Запустить умные функции',
                'Сделать планирование дня',
                'Функция планирования дня',
              ],
            })
      },
    }
    const parsed = await parseTaskMessage(qualityAware, {
      text:
        'Мне завтра нужно доделать выкат Милавицы на VDS и поправить все косяки. Второе про FocusBot. Нужно запустить умные функции. Надо сделать планирование дня. Функцию планирования дня.',
      tasks,
      currentTaskId: null,
    })

    expect(parsed.failure).toBeNull()
    expect(parsed.result).toEqual({
      kind: 'capture',
      titles: [
        'Доделать выкат Милавицы на VDS',
        'Поправить все косяки',
        'Запустить умные функции FocusBot',
        'Сделать функцию планирования дня',
      ],
      llmUsed: true,
    })
  })

  it('не склеивает разные действия над одним объектом', async () => {
    const parsed = await parseTaskMessage(
      provider('{"kind":"capture","new_tasks":["Сделать форму оплаты","Проверить форму оплаты"]}'),
      { text: 'Сделать форму оплаты и проверить форму оплаты', tasks, currentTaskId: null },
    )

    expect(parsed.result).toEqual({
      kind: 'capture',
      titles: ['Сделать форму оплаты', 'Проверить форму оплаты'],
      llmUsed: true,
    })
  })

  it('один раз повторяет только структурно невалидный ответ', async () => {
    let calls = 0
    const flaky: LlmProvider = {
      enabled: true,
      async complete() {
        calls += 1
        if (calls === 1) return '{"kind":"capture","new_tasks":"Сделать отчёт","start_task":"t1"}'
        return '{"kind":"capture","new_tasks":["Сделать отчёт","Отправить отчёт"]}'
      },
    }

    const parsed = await parseTaskMessage(flaky, {
      text: 'Сделать отчёт и отправить отчёт',
      tasks,
      currentTaskId: null,
    })

    expect(calls).toBe(2)
    expect(parsed.result).toEqual({
      kind: 'capture',
      titles: ['Сделать отчёт', 'Отправить отчёт'],
      llmUsed: true,
    })
  })

  it('не повторяет ошибку провайдера', async () => {
    let calls = 0
    const unavailable: LlmProvider = {
      enabled: true,
      async complete() {
        calls += 1
        throw new Error('provider unavailable')
      },
    }

    const parsed = await parseTaskMessage(unavailable, {
      text: 'Сделать отчёт и отправить отчёт',
      tasks,
      currentTaskId: null,
    })

    expect(calls).toBe(1)
    expect(parsed.result).toBeNull()
    expect(parsed.failure).toMatchObject({ ok: false, reason: 'error' })
  })

  it('переводит только временные метки своих задач в id', async () => {
    const parsed = await parseTaskMessage(
      provider('{"kind":"complete_and_start","new_tasks":[],"complete_task":"t1","start_task":"t2","start_title":null}'),
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
      provider('{"kind":"complete_and_start","new_tasks":[],"complete_task":"t99","start_task":null,"start_title":"Новая задача"}'),
      { text: 'Сделал старую, начинаю новую', tasks, currentTaskId: 'own-a' },
    )

    expect(parsed.result).toBeNull()
    expect(parsed.failure).toMatchObject({ ok: false, reason: 'invalid' })
  })

  it('возвращает обычное намерение без операций с задачами', async () => {
    const parsed = await parseTaskMessage(
      provider('{"kind":"session_intent","new_tasks":[],"complete_task":null,"start_task":null,"start_title":null}'),
      { text: 'Поработаю над презентацией', tasks, currentTaskId: null },
    )

    expect(parsed.result).toEqual({ kind: 'session_intent', llmUsed: true })
  })
})
