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
      provider('{"kind":"capture","new_tasks":["Подготовить отчёт","Купить корм"],"start_title":null}'),
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

  it('нормализует список задач с ошибочным kind session_intent', async () => {
    const parsed = await parseTaskMessage(
      provider(
        '{"kind":"session_intent","new_tasks":["Выкатить Милавицу на VDS","Поправить все косяки","Запустить умные функции FocusBot","Сделать планирование дня"]}',
      ),
      {
        text:
          'Мне завтра нужно выкатить Милавицу на VDS, поправить все косяки, запустить умные функции FocusBot и сделать планирование дня',
        tasks,
        currentTaskId: null,
      },
    )

    expect(parsed.failure).toBeNull()
    expect(parsed.result).toEqual({
      kind: 'capture',
      titles: [
        'Выкатить Милавицу на VDS',
        'Поправить все косяки',
        'Запустить умные функции FocusBot',
        'Сделать планирование дня',
      ],
      llmUsed: true,
    })
  })

  it('не передаёт активные задачи модели при захвате списка', async () => {
    const observed: LlmProvider = {
      enabled: true,
      async complete(req) {
        expect(JSON.parse(req.input)).toEqual({ text: 'Нужно доделать выкат и поправить ошибки', has_current_task: false })
        expect(req.system).toContain('полного упорядоченного списка')
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
        expect(JSON.parse(req.input)).toMatchObject({ has_current_task: false })
        return hasCoverageRule && hasDedupeRule
          ? JSON.stringify({
              kind: 'capture',
              new_tasks: [
                'Доделать выкат Милавицы на VDS',
                'Поправить все косяки',
                'Запустить умные функции FocusBot',
                'Сделать планирование дня',
                'Планирование дня',
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
      tasks: [...tasks, { id: 'own-c', title: 'Перенос Милавицы на vds' }],
      currentTaskId: null,
    })

    expect(parsed.failure).toBeNull()
    expect(parsed.result).toEqual({
      kind: 'capture',
      titles: [
        'Доделать выкат Милавицы на VDS',
        'Поправить все косяки',
        'Запустить умные функции FocusBot',
        'Сделать планирование дня',
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

  it('сохраняет единственную уже активную задачу для выбора', async () => {
    const parsed = await parseTaskMessage(provider('{"kind":"capture","new_tasks":["Подготовить презентацию"]}'), {
      text: 'Добавь задачу подготовить презентацию',
      tasks,
      currentTaskId: null,
    })

    expect(parsed.result).toEqual({ kind: 'capture', titles: ['Подготовить презентацию'], llmUsed: true })
  })

  it('показывает весь распознанный список, даже если часть задач уже активна', async () => {
    const parsed = await parseTaskMessage(
      provider(
        '{"kind":"capture","new_tasks":["Доделать выкат Милавицы на VDS","Поправить все косяки","Запустить умные функции FocusBot","Сделать функцию планирования дня"]}',
      ),
      {
        text:
          'Мне завтра нужно доделать выкат Милавицы на VDS и поправить все косяки. Второе про FocusBot. Нужно запустить умные функции. Надо сделать функцию планирования дня.',
        tasks: [
          { id: 'existing-a', title: 'Доделать выкат Милавицы на VDS' },
          { id: 'existing-b', title: 'Запустить умные функции FocusBot' },
          { id: 'existing-c', title: 'Сделать функцию планирования дня' },
        ],
        currentTaskId: null,
      },
    )

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

  it('не передаёт модели список задач даже при переключении', async () => {
    const switching: LlmProvider = {
      enabled: true,
      async complete(req) {
        expect(JSON.parse(req.input)).toEqual({
          text: 'Первую сделал, перехожу ко второй',
          has_current_task: true,
        })
        return '{"kind":"complete_and_start","new_tasks":[],"start_title":"Позвонить Ивану"}'
      },
    }
    const parsed = await parseTaskMessage(
      switching,
      { text: 'Первую сделал, перехожу ко второй', tasks, currentTaskId: 'own-a' },
    )

    expect(parsed.failure).toBeNull()
    expect(parsed.result).toEqual({ kind: 'complete_and_start', title: 'Позвонить Ивану', llmUsed: true })
  })

  it('понимает произвольную фразу как старт задачи без передачи списка задач', async () => {
    const observed: LlmProvider = {
      enabled: true,
      async complete(req) {
        expect(JSON.parse(req.input)).toEqual({
          text: 'Всё, налетаю на презентацию',
          has_current_task: false,
        })
        return '{"kind":"start_task","new_tasks":[],"start_title":"Подготовить презентацию"}'
      },
    }

    const parsed = await parseTaskMessage(observed, {
      text: 'Всё, налетаю на презентацию',
      tasks,
      currentTaskId: null,
    })

    expect(parsed.failure).toBeNull()
    expect(parsed.result).toEqual({ kind: 'start_task', title: 'Подготовить презентацию', llmUsed: true })
  })

  it('понимает свободную фразу о завершении текущей задачи и переходе', async () => {
    const parsed = await parseTaskMessage(
      provider('{"kind":"complete_and_start","new_tasks":[],"start_title":"Позвонить Ивану"}'),
      { text: 'С этим разобрался, теперь наберу Ивана', tasks, currentTaskId: 'own-a' },
    )

    expect(parsed.failure).toBeNull()
    expect(parsed.result).toEqual({ kind: 'complete_and_start', title: 'Позвонить Ивану', llmUsed: true })
  })

  it('понимает произвольную фразу как конец дня', async () => {
    const parsed = await parseTaskMessage(
      provider('{"kind":"close_day","new_tasks":[],"start_title":null}'),
      { text: 'С меня хватит, закругляемся до завтра', tasks, currentTaskId: 'own-a' },
    )

    expect(parsed.failure).toBeNull()
    expect(parsed.result).toEqual({ kind: 'close_day', llmUsed: true })
  })

  it('отвергает старт без названия задачи', async () => {
    const parsed = await parseTaskMessage(
      provider('{"kind":"start_task","new_tasks":[],"start_title":null}'),
      { text: 'Сделал старую, начинаю новую', tasks, currentTaskId: 'own-a' },
    )

    expect(parsed.result).toBeNull()
    expect(parsed.failure).toMatchObject({ ok: false, reason: 'invalid' })
  })

  it('возвращает обычное намерение без операций с задачами', async () => {
    const parsed = await parseTaskMessage(
      provider('{"kind":"session_intent","new_tasks":[],"start_title":null}'),
      { text: 'Поработаю над презентацией', tasks, currentTaskId: null },
    )

    expect(parsed.result).toEqual({ kind: 'session_intent', llmUsed: true })
  })
})
