import { beforeEach, describe, expect, it } from 'vitest'
import type { LlmProvider } from '../llm/provider.js'
import type { SttProvider } from '../stt/provider.js'
import { makeBot } from '../test/bot.js'
import { hasDb, prisma, resetDb } from '../test/db.js'

const A = 2085
const B = 2086
const C = 2087

const reply = (text: string) => ({ text, usage: null })

const llm = (answer: string): LlmProvider => ({
  enabled: true,
  model: 'test-model',
  async complete(req) {
    if (req.system.includes('сообщение пользователя фокус-боту')) return reply(answer)
    throw new Error('unexpected LLM call')
  },
})

const conversational = (classify: (text: string) => string, resolve?: (intent: string, tasks: { label: string; title: string }[]) => string): LlmProvider => ({
  enabled: true,
  model: 'test-model',
  async complete(req) {
    if (req.system.includes('сообщение пользователя фокус-боту')) return reply(classify(JSON.parse(req.input).text))
    if (req.system.includes('намерение пользователя перед рабочей сессией')) {
      const input = JSON.parse(req.input)
      return reply(resolve?.(input.intent, input.tasks) ?? JSON.stringify({ task: null, title: input.intent, scope: 'step' }))
    }
    throw new Error('unexpected LLM call')
  },
})

const capture = llm(
  '{"kind":"capture","new_tasks":["Подготовить отчёт","Купить корм"],"start_title":null}',
)

describe.skipIf(!hasDb)('список задач из текста и голоса', () => {
  beforeEach(resetDb)

  it('сразу запускает 40 минут и привязывает выбранную задачу без перезапуска таймера', async () => {
    const bot = makeBot()
    await bot.onboard(A)
    const user = await prisma.user.findUniqueOrThrow({ where: { tgId: BigInt(A) } })
    const first = await prisma.task.create({ data: { userId: user.id, title: 'Подготовить отчёт' } })
    const second = await prisma.task.create({ data: { userId: user.id, title: 'Позвонить Ивану' } })

    await bot.text(A, 'Начать сессию')

    const started = await prisma.focusSession.findFirstOrThrow({ where: { state: 'running' } })
    expect(started).toMatchObject({ taskId: null, intentText: null, plannedMinutes: 40 })
    expect(bot.lastText(A)).toContain('Таймер уже идёт')
    const listMessage = bot.tg.sent.filter((message) => message.chatId === BigInt(A)).at(-1)
    expect(listMessage?.keyboard?.slice(0, 2)).toEqual([
      [{ text: first.title, data: `task:${first.id}:view0` }],
      [{ text: second.title, data: `task:${second.id}:view0` }],
    ])
    expect(bot.buttons(A).filter((button) => button.data.endsWith(':start'))).toHaveLength(0)

    await bot.press(A, `task:${first.id}:view0`)
    expect(bot.lastText(A)).toContain(first.title)
    expect(bot.buttons(A).filter((button) => button.data === `task:${first.id}:start`)).toHaveLength(1)
    expect(bot.buttons(A).filter((button) => button.data === `task:${first.id}:done`)).toHaveLength(1)
    expect(bot.buttons(A).filter((button) => button.data === `task:${first.id}:edit`)).toHaveLength(1)
    expect(bot.buttons(A).filter((button) => button.data === `task:${first.id}:drop`)).toHaveLength(1)
    await bot.press(A, `task:${first.id}:start`)
    const running = await prisma.focusSession.findFirstOrThrow({ where: { state: 'running' } })
    expect(running).toMatchObject({ id: started.id, taskId: first.id, intentText: first.title, plannedMinutes: 40 })
    expect(running.startedAt).toEqual(started.startedAt)
    expect(running.plannedEndAt).toEqual(started.plannedEndAt)
    expect(bot.lastText(A)).toContain('Таймер продолжает идти')

    await bot.press(A, `task:${second.id}:view0`)
    await bot.press(A, `task:${second.id}:start`)
    const switched = await prisma.focusSession.findUniqueOrThrow({ where: { id: started.id } })
    expect(switched).toMatchObject({ taskId: second.id, intentText: second.title })
    expect(switched.startedAt).toEqual(started.startedAt)
    expect(switched.plannedEndAt).toEqual(started.plannedEndAt)
    expect(await prisma.task.findUniqueOrThrow({ where: { id: first.id } })).toMatchObject({ sessionsCount: 0 })
    expect(await prisma.task.findUniqueOrThrow({ where: { id: second.id } })).toMatchObject({ sessionsCount: 1 })
  })

  it('открывает задачи без старта сессии по кнопке и команде и листает весь список', async () => {
    const bot = makeBot()
    await bot.onboard(A)
    const user = await prisma.user.findUniqueOrThrow({ where: { tgId: BigInt(A) } })
    await prisma.task.createMany({
      data: Array.from({ length: 8 }, (_, index) => ({
        userId: user.id,
        title: `Задача ${index + 1}`,
        createdAt: new Date(Date.UTC(2026, 8, 25, 10, index)),
      })),
    })

    await bot.text(A, 'Мои задачи')
    expect(bot.lastText(A)).toContain('Задача 1')
    expect(bot.lastText(A)).not.toContain('Задача 7')
    expect(await prisma.focusSession.count({ where: { userId: user.id, state: 'running' } })).toBe(0)

    await bot.press(A, 'tasks::p1')
    expect(bot.lastText(A)).toContain('Задача 7')
    expect(bot.lastText(A)).toContain('Задача 8')
    const secondPage = bot.tg.sent.filter((message) => message.chatId === BigInt(A)).at(-1)
    expect(secondPage?.keyboard?.slice(0, 2).every((row) => row.length === 1)).toBe(true)
    const task7 = await prisma.task.findFirstOrThrow({ where: { userId: user.id, title: 'Задача 7' } })
    await bot.press(A, `task:${task7.id}:view1`)
    expect(bot.lastText(A)).toContain('Задача 7')
    expect(bot.buttons(A).some((button) => button.data === 'tasks::p1')).toBe(true)

    await bot.text(A, '/tasks')
    expect(bot.lastText(A)).toContain('Задача 1')
    expect(await prisma.focusSession.count({ where: { userId: user.id, state: 'running' } })).toBe(0)
  })

  it('мягко удаляет задачу, позволяет вернуть её и не удаляет текущую', async () => {
    const bot = makeBot()
    await bot.onboard(A)
    const user = await prisma.user.findUniqueOrThrow({ where: { tgId: BigInt(A) } })
    const removable = await prisma.task.create({ data: { userId: user.id, title: 'Лишняя задача' } })
    const current = await prisma.task.create({ data: { userId: user.id, title: 'Текущая задача' } })

    await bot.press(A, `task:${removable.id}:view0`)
    await bot.press(A, `task:${removable.id}:drop`)
    expect(await prisma.task.findUniqueOrThrow({ where: { id: removable.id } })).toMatchObject({ status: 'dropped' })
    expect(bot.textsTo(A).some((text) => text.includes('Убрал «Лишняя задача»'))).toBe(true)

    await bot.press(A, `task:${removable.id}:restore`)
    expect(await prisma.task.findUniqueOrThrow({ where: { id: removable.id } })).toMatchObject({ status: 'active' })
    expect(bot.lastText(A)).toContain('Вернул «Лишняя задача»')

    await bot.press(A, `task:${current.id}:start`)
    await bot.press(A, `task:${current.id}:drop`)
    expect(await prisma.task.findUniqueOrThrow({ where: { id: current.id } })).toMatchObject({ status: 'active' })
    expect(bot.lastText(A)).toContain('идёт в текущей сессии')
  })

  it('переименовывает активную задачу и текущую сессию через карточку', async () => {
    const bot = makeBot()
    await bot.onboard(A)
    const user = await prisma.user.findUniqueOrThrow({ where: { tgId: BigInt(A) } })
    const task = await prisma.task.create({ data: { userId: user.id, title: 'Сделать отчёт' } })
    await bot.press(A, `task:${task.id}:start`)

    await bot.press(A, `task:${task.id}:edit`)
    expect(await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).toMatchObject({ pendingInput: `task_edit:${task.id}` })
    expect(bot.lastText(A)).toContain('новое название')

    await bot.text(A, '  Подготовить   квартальный отчёт  ')

    expect(await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).toMatchObject({
      title: 'Подготовить квартальный отчёт',
      status: 'active',
    })
    expect(await prisma.focusSession.findFirstOrThrow({ where: { taskId: task.id, state: 'running' } })).toMatchObject({
      intentText: 'Подготовить квартальный отчёт',
    })
    expect(await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).toMatchObject({ pendingInput: 'none' })
    expect(bot.lastText(A)).toContain('Переименовал')
  })

  it('создаёт список из текста, не дублирует его и запускает выбранную задачу', async () => {
    const bot = makeBot({ llm: capture })
    await bot.onboard(A)

    await bot.text(A, 'Сегодня хочу сделать отчёт и купить корм')
    expect(await prisma.task.count()).toBe(2)
    expect(bot.lastText(A)).toContain('Подготовить отчёт')
    expect(bot.lastText(A)).toContain('Купить корм')

    await bot.text(A, 'Сегодня хочу сделать отчёт и купить корм')
    expect(await prisma.task.count()).toBe(2)

    const buy = bot.buttons(A).filter((button) => button.text.includes('Купить корм')).at(-1)
    if (!buy) throw new Error('нет кнопки задачи «Купить корм»')
    await bot.press(A, buy.data)
    expect(bot.lastText(A)).toContain('Купить корм')
    await bot.press(A, `task:${buy.data.split(':')[1]}:start`)
    const running = await prisma.focusSession.findFirstOrThrow({ where: { state: 'running' }, include: { task: true } })
    expect(running.task?.title).toBe('Купить корм')
    expect(running.intentText).toBe('Купить корм')
  })

  it('показывает весь повторный список и создаёт только отсутствующие задачи', async () => {
    const repeated = llm(
      '{"kind":"capture","new_tasks":["Доделать выкат Милавицы на VDS","Поправить все косяки","Запустить умные функции FocusBot","Сделать функцию планирования дня"]}',
    )
    const transcript =
      'Мне завтра нужно доделать выкат Милавицы на VDS и поправить все косяки. Второе про FocusBot. Нужно запустить умные функции. Надо сделать функцию планирования дня.'
    const stt: SttProvider = { enabled: true, model: 'test-stt', async transcribe() { return transcript } }
    const bot = makeBot({ llm: repeated, stt })
    bot.tg.downloads.set('voice-repeat', new Uint8Array([1, 2, 3]))
    await bot.onboard(B)
    const user = await prisma.user.findUniqueOrThrow({ where: { tgId: BigInt(B) } })
    await prisma.task.createMany({
      data: [
        { userId: user.id, title: 'Доделать выкат Милавицы на VDS' },
        { userId: user.id, title: 'Запустить умные функции FocusBot' },
        { userId: user.id, title: 'Сделать функцию планирования дня' },
      ],
    })

    await bot.voice(B, { fileId: 'voice-repeat', duration: 30, mimeType: 'audio/ogg', fileSize: 3 })

    expect(await prisma.task.count({ where: { userId: user.id } })).toBe(4)
    expect(bot.lastText(B)).toContain('Доделать выкат Милавицы на VDS')
    expect(bot.lastText(B)).toContain('Поправить все косяки')
    expect(bot.lastText(B)).toContain('Запустить умные функции FocusBot')
    expect(bot.lastText(B)).toContain('Сделать функцию планирования дня')
  })

  it('распознаёт voice в памяти и пропускает через тот же парсер', async () => {
    const stt: SttProvider = {
      enabled: true,
      model: 'test-stt',
      async transcribe(req) {
        expect([...req.audio]).toEqual([1, 2, 3])
        expect(req.mimeType).toBe('audio/ogg')
        return 'Сегодня хочу сделать отчёт и купить корм'
      },
    }
    const bot = makeBot({ llm: capture, stt })
    bot.tg.downloads.set('voice-a', new Uint8Array([1, 2, 3]))
    await bot.onboard(A)

    await bot.voice(A, { fileId: 'voice-a', duration: 12, mimeType: 'audio/ogg', fileSize: 3 })

    expect(await prisma.task.count()).toBe(2)
    expect(bot.textsTo(A)).toContain('Распознал: «Сегодня хочу сделать отчёт и купить корм».')
    expect(await prisma.event.findFirst({ where: { type: 'voice_transcribed' } })).not.toBeNull()
    expect(
      (await prisma.componentCall.findMany({ orderBy: { id: 'asc' } })).map((call) => [call.name, call.model, call.status]),
    ).toEqual([
      ['voice_transcription', 'test-stt', 'ok'],
      ['tasks', 'test-model', 'ok'],
    ])
  })

  it('не скачивает слишком длинный voice и безопасно отвечает при выключенном STT', async () => {
    const bot = makeBot({ llm: capture })
    await bot.onboard(A)

    await bot.voice(A, { fileId: 'too-long', duration: 181, mimeType: 'audio/ogg', fileSize: 3 })
    expect(bot.tg.downloadRequests).toEqual([])
    expect(bot.lastText(A)).toContain('не длиннее 3 минут')

    await bot.voice(A, { fileId: 'short', duration: 10, mimeType: 'audio/ogg', fileSize: 3 })
    expect(bot.tg.downloadRequests).toEqual([])
    expect(bot.lastText(A)).toContain('Распознавание голоса сейчас выключено')
  })

  it('ограничивает платное распознавание пятью voice в час до скачивания шестого', async () => {
    const stt: SttProvider = { enabled: true, model: 'test-stt', async transcribe() { return 'Сегодня хочу сделать отчёт и купить корм' } }
    const bot = makeBot({ llm: capture, stt })
    await bot.onboard(C)
    for (let i = 1; i <= 6; i++) {
      bot.tg.downloads.set(`voice-${i}`, new Uint8Array([i]))
      await bot.voice(C, { fileId: `voice-${i}`, duration: 10, mimeType: 'audio/ogg', fileSize: 1 })
    }

    expect(bot.tg.downloadRequests).toHaveLength(5)
    expect(bot.lastText(C)).toContain('до 5 голосовых')
  })

  it('явно завершает текущую задачу и меняет её без перезапуска рабочего периода', async () => {
    const switchLlm = conversational(
      () => '{"kind":"complete_and_start","new_tasks":[],"start_title":"Позвонить Ивану"}',
      (_intent, active) => JSON.stringify({ task: active.find((task) => task.title === 'Позвонить Ивану')?.label ?? null, title: 'Позвонить Ивану', scope: 'step' }),
    )
    const bot = makeBot({ llm: switchLlm })
    await bot.onboard(A)
    const user = await prisma.user.findUniqueOrThrow({ where: { tgId: BigInt(A) } })
    const first = await prisma.task.create({ data: { userId: user.id, title: 'Подготовить презентацию' } })
    const second = await prisma.task.create({ data: { userId: user.id, title: 'Позвонить Ивану' } })

    await bot.press(A, `task:${first.id}:start`)
    const started = await prisma.focusSession.findFirstOrThrow({ where: { taskId: first.id, state: 'running' } })
    bot.advance(10)
    await bot.text(A, 'Эту сделал и приступаю к звонку Ивану')

    expect(await prisma.task.findUniqueOrThrow({ where: { id: first.id } })).toMatchObject({ status: 'done' })
    const running = await prisma.focusSession.findUniqueOrThrow({ where: { id: started.id } })
    expect(running).toMatchObject({ state: 'running', taskId: second.id, intentText: 'Позвонить Ивану' })
    expect(running.startedAt).toEqual(started.startedAt)
    expect(running.plannedEndAt).toEqual(started.plannedEndAt)
    expect(await prisma.focusSession.count({ where: { userId: user.id } })).toBe(1)
    expect(bot.lastText(A)).toContain('Таймер продолжает идти')
  })

  it('по voice отмечает названную задачу готовой, не закрывая день', async () => {
    const transcript = 'Я сделал одну из своих задач — планирование дня'
    const bot = makeBot({
      stt: { enabled: true, model: 'test-stt', async transcribe() { return transcript } },
      llm: conversational(
        () => '{"kind":"complete_task","new_tasks":[],"start_title":null,"complete_title":"Сделать планирование дня"}',
        (_intent, active) => JSON.stringify({ task: active[0]?.label ?? null, title: 'Сделать планирование дня', scope: 'step' }),
      ),
    })
    bot.tg.downloads.set('voice-complete', new Uint8Array([1, 2, 3]))
    await bot.onboard(A)
    const user = await prisma.user.findUniqueOrThrow({ where: { tgId: BigInt(A) } })
    const task = await prisma.task.create({ data: { userId: user.id, title: 'Сделать планирование дня' } })

    await bot.voice(A, { fileId: 'voice-complete', duration: 6, mimeType: 'audio/ogg', fileSize: 3 })

    expect(await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).toMatchObject({ status: 'done' })
    expect(await prisma.event.findFirst({ where: { type: 'day_closed' } })).toBeNull()
    expect(await prisma.event.findFirst({ where: { type: 'task_completed' } })).not.toBeNull()
    expect(bot.lastText(A)).toContain('отметил готовой')
  })

  it('в точной production-фразе завершает и задачу, и день', async () => {
    const transcript = 'Все, я закончил на сегодня работу. Меловицу я выкатил.'
    const bot = makeBot({
      stt: { enabled: true, model: 'test-stt', async transcribe() { return transcript } },
      llm: conversational(
        () => '{"kind":"complete_and_close_day","new_tasks":[],"start_title":null,"complete_title":"Выкатить Милавицу"}',
        (_intent, active) => JSON.stringify({ task: active[0]?.label ?? null, title: 'Выкатить Милавицу', scope: 'step' }),
      ),
    })
    bot.tg.downloads.set('voice-complete-day', new Uint8Array([1, 2, 3]))
    await bot.onboard(A)
    const user = await prisma.user.findUniqueOrThrow({ where: { tgId: BigInt(A) } })
    const task = await prisma.task.create({ data: { userId: user.id, title: 'Выкатить Милавицу' } })

    await bot.voice(A, { fileId: 'voice-complete-day', duration: 6, mimeType: 'audio/ogg', fileSize: 3 })

    expect(await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).toMatchObject({ status: 'done' })
    expect(await prisma.event.findFirst({ where: { type: 'task_completed' } })).not.toBeNull()
    expect(await prisma.event.findFirst({ where: { type: 'day_closed' } })).not.toBeNull()
    expect(bot.textsTo(A).some((text) => text.includes('отметил готовой'))).toBe(true)
    expect(bot.lastText(A)).toContain('Когда встретимся')
  })

  it('по слову «эту» закрывает текущую задачу, а таймер идёт дальше', async () => {
    const bot = makeBot({
      llm: conversational(() => '{"kind":"complete_task","new_tasks":[],"start_title":null,"complete_title":null}'),
    })
    await bot.onboard(A)
    const user = await prisma.user.findUniqueOrThrow({ where: { tgId: BigInt(A) } })
    const task = await prisma.task.create({ data: { userId: user.id, title: 'Подготовить презентацию' } })
    await bot.press(A, `task:${task.id}:start`)
    bot.advance(12)

    await bot.text(A, 'Эту закончил')

    expect(await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).toMatchObject({ status: 'done' })
    // Закрытие задачи сессию не заканчивает (решение 01.10).
    expect(await prisma.focusSession.findFirstOrThrow({ where: { userId: user.id, state: 'running' } })).toMatchObject({ taskId: null })
    expect(await prisma.outboxMessage.count({ where: { userId: user.id, status: 'pending', kind: 'session_end' } })).toBe(1)
    expect(bot.lastText(A)).toContain('Таймер идёт дальше')
  })

  it('не создаёт задачу, если завершить названную задачу не удалось сопоставить', async () => {
    const bot = makeBot({
      llm: conversational(
        () => '{"kind":"complete_task","new_tasks":[],"start_title":null,"complete_title":"Несуществующая задача"}',
        () => JSON.stringify({ task: null, title: 'Несуществующая задача', scope: 'step' }),
      ),
    })
    await bot.onboard(A)
    const user = await prisma.user.findUniqueOrThrow({ where: { tgId: BigInt(A) } })
    await prisma.task.create({ data: { userId: user.id, title: 'Подготовить презентацию' } })

    await bot.text(A, 'Я закончил несуществующую задачу')

    expect(await prisma.task.count({ where: { userId: user.id } })).toBe(1)
    expect(bot.lastText(A)).toContain('какую задачу отметить готовой')
  })

  it('не закрывает день частично, если задача из составной команды не найдена', async () => {
    const bot = makeBot({
      llm: conversational(
        () => '{"kind":"complete_and_close_day","new_tasks":[],"start_title":null,"complete_title":"Несуществующая задача"}',
        () => JSON.stringify({ task: null, title: 'Несуществующая задача', scope: 'step' }),
      ),
    })
    await bot.onboard(A)
    const user = await prisma.user.findUniqueOrThrow({ where: { tgId: BigInt(A) } })
    await prisma.task.create({ data: { userId: user.id, title: 'Подготовить презентацию' } })

    await bot.text(A, 'На сегодня всё, несуществующую задачу закончил')

    expect(await prisma.task.count({ where: { userId: user.id, status: 'done' } })).toBe(0)
    expect(await prisma.event.findFirst({ where: { type: 'day_closed' } })).toBeNull()
    expect(bot.lastText(A)).toContain('какую задачу отметить готовой')
  })

  it('не создаёт следующую задачу, если текущей задачи для завершения нет', async () => {
    const bot = makeBot({
      llm: conversational(() => '{"kind":"complete_and_start","new_tasks":[],"start_title":"Новая задача"}'),
    })
    await bot.onboard(A)

    await bot.text(A, 'С этим всё, перехожу к новой задаче')

    expect(await prisma.task.count()).toBe(0)
    expect(bot.lastText(A)).toContain('нет текущей задачи')
  })

  it('по произвольной фразе находит задачу и сразу запускает таймер', async () => {
    const bot = makeBot({
      llm: conversational(
        () => '{"kind":"start_task","new_tasks":[],"start_title":"Подготовить презентацию"}',
        (_intent, active) => JSON.stringify({ task: active[0]?.label ?? null, title: 'Подготовить презентацию', scope: 'step' }),
      ),
    })
    await bot.onboard(A)
    const user = await prisma.user.findUniqueOrThrow({ where: { tgId: BigInt(A) } })
    const task = await prisma.task.create({ data: { userId: user.id, title: 'Подготовить презентацию' } })

    await bot.text(A, 'Всё, налетаю на слайды')

    const running = await prisma.focusSession.findFirstOrThrow({ where: { userId: user.id, state: 'running' } })
    expect(running).toMatchObject({ taskId: task.id, intentText: task.title, plannedMinutes: 40 })
    expect(bot.lastText(A)).toContain('Поехали')
  })

  it('по голосовой команде создаёт отсутствующую задачу и сразу запускает таймер', async () => {
    const transcript = 'Хорош тянуть, берусь за макет лендинга'
    const stt: SttProvider = { enabled: true, model: 'test-stt', async transcribe() { return transcript } }
    const bot = makeBot({
      stt,
      llm: conversational(() => '{"kind":"start_task","new_tasks":[],"start_title":"Сделать макет лендинга"}'),
    })
    bot.tg.downloads.set('voice-start', new Uint8Array([1, 2, 3]))
    await bot.onboard(B)
    const user = await prisma.user.findUniqueOrThrow({ where: { tgId: BigInt(B) } })

    await bot.voice(B, { fileId: 'voice-start', duration: 8, mimeType: 'audio/ogg', fileSize: 3 })

    const task = await prisma.task.findFirstOrThrow({ where: { userId: user.id, title: 'Сделать макет лендинга' } })
    expect(await prisma.focusSession.findFirstOrThrow({ where: { userId: user.id, state: 'running' } })).toMatchObject({ taskId: task.id })
    expect(bot.textsTo(B)).toContain(`Распознал: «${transcript}».`)
  })

  it('не запускает чужую задачу из поддельного callback', async () => {
    const bot = makeBot({ llm: capture })
    await bot.onboard(A)
    await bot.onboard(B)
    const other = await prisma.user.findUniqueOrThrow({ where: { tgId: BigInt(B) } })
    const task = await prisma.task.create({ data: { userId: other.id, title: 'Чужая задача' } })

    await bot.press(A, `task:${task.id}:view0`)
    expect(bot.lastText(A)).toContain('неактуально')

    await bot.press(A, `task:${task.id}:start`)

    expect(await prisma.focusSession.count({ where: { taskId: task.id } })).toBe(0)
    expect(bot.lastText(A)).toContain('неактуально')

    await bot.press(A, `task:${task.id}:drop`)
    expect(await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).toMatchObject({ status: 'active' })
    expect(bot.lastText(A)).toContain('неактуально')

    await bot.press(A, `task:${task.id}:edit`)
    expect(await prisma.user.findUniqueOrThrow({ where: { tgId: BigInt(A) } })).toMatchObject({ pendingInput: 'none' })
    expect(bot.lastText(A)).toContain('неактуально')

    await bot.press(A, `task:${task.id}:done`)
    expect(await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).toMatchObject({ status: 'active' })
    expect(bot.lastText(A)).toContain('неактуально')

    await bot.press(A, `task:${task.id}:split`)
    expect(await prisma.user.findUniqueOrThrow({ where: { tgId: BigInt(A) } })).toMatchObject({ pendingInput: 'none' })
    await bot.press(A, `task:${task.id}:splitauto`)
    expect(bot.lastText(A)).toContain('неактуально')
    expect(await prisma.task.count({ where: { userId: other.id } })).toBe(1)
  })
})

describe.skipIf(!hasDb)('добавить задачу без старта', () => {
  beforeEach(resetDb)

  it('кнопка в «Мои задачи» сохраняет задачу без сессии и открывает её карточку с «Разобрать»', async () => {
    const bot = makeBot()
    await bot.onboard(A)
    const user = await prisma.user.findUniqueOrThrow({ where: { tgId: BigInt(A) } })

    await bot.text(A, 'Мои задачи')
    expect(bot.lastButton(A, 'tasks::add')).toBe('tasks::add')
    await bot.press(A, 'tasks::add')
    expect(bot.lastText(A)).toContain('Как назвать задачу?')
    await bot.text(A, 'коллекция')

    const task = await prisma.task.findFirstOrThrow({ where: { userId: user.id } })
    expect(task).toMatchObject({ title: 'коллекция', status: 'active' })
    expect(await prisma.focusSession.count({ where: { userId: user.id, state: { in: ['running', 'paused'] } } })).toBe(0)
    expect(bot.lastText(A)).toContain('Добавил «коллекция».')
    expect(bot.lastText(A)).toContain('Задача: «коллекция»')
    expect(bot.lastButton(A, `task:${task.id}:split`)).toBe(`task:${task.id}:split`)
    expect(await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).toMatchObject({ pendingInput: 'none' })
  })

  it('несколько строк — несколько задач; кнопка есть и в пустом списке', async () => {
    const bot = makeBot()
    await bot.onboard(A)
    const user = await prisma.user.findUniqueOrThrow({ where: { tgId: BigInt(A) } })

    await bot.text(A, '/tasks')
    expect(bot.lastText(A)).toContain('Активных задач пока нет')
    await bot.press(A, bot.lastButton(A, 'tasks::add'))
    await bot.text(A, 'локалка\nколлекция')

    expect((await prisma.task.findMany({ where: { userId: user.id }, orderBy: { createdAt: 'asc' } })).map((t) => t.title)).toEqual(['локалка', 'коллекция'])
    expect(bot.lastText(A)).toContain('В списке 2 задачи')
    expect(await prisma.focusSession.count({ where: { userId: user.id, state: { in: ['running', 'paused'] } } })).toBe(0)
  })

  it('«задача коллекция» в свободном тексте — добавление, а не старт', async () => {
    const bot = makeBot({ llm: llm('{"kind":"capture","new_tasks":["Коллекция"],"start_title":null}') })
    await bot.onboard(A)
    const user = await prisma.user.findUniqueOrThrow({ where: { tgId: BigInt(A) } })

    await bot.text(A, 'задача коллекция')

    const task = await prisma.task.findFirstOrThrow({ where: { userId: user.id } })
    expect(await prisma.focusSession.count({ where: { userId: user.id, state: { in: ['running', 'paused'] } } })).toBe(0)
    expect(bot.lastText(A)).toContain('Добавил «Коллекция».')
    expect(bot.lastButton(A, `task:${task.id}:split`)).toBe(`task:${task.id}:split`)
  })
})

// Модель разбора: отвечает только на свой промт и запоминает, что получила.
const breakdown = (steps: string[] | null) => {
  const inputs: { task: string; answer: string | null; recent_context: unknown[] }[] = []
  const provider: LlmProvider = {
    enabled: true,
    model: 'test-model',
    async complete(req) {
      if (!req.system.includes('разбить задачу пользователя')) throw new Error('unexpected LLM call')
      inputs.push(JSON.parse(req.input))
      return reply(steps ? JSON.stringify({ steps }) : 'не json')
    },
  }
  return { provider, inputs }
}

describe.skipIf(!hasDb)('разбор задачи на шаги', () => {
  beforeEach(resetDb)

  async function taskCard(bot: ReturnType<typeof makeBot>, tgId: number, title = 'Написать курсовую') {
    await bot.onboard(tgId)
    const user = await prisma.user.findUniqueOrThrow({ where: { tgId: BigInt(tgId) } })
    const task = await prisma.task.create({ data: { userId: user.id, title } })
    await bot.press(tgId, `task:${task.id}:view0`)
    return { user, task }
  }

  it('сначала спрашивает, как человек видит задачу, и строит шаги от его ответа', async () => {
    const llm = breakdown(['Перечитать требования', 'Набросать план', 'Написать введение'])
    const bot = makeBot({ llm: llm.provider })
    const { user, task } = await taskCard(bot, A)
    expect(bot.lastButton(A, `task:${task.id}:split`)).toBe(`task:${task.id}:split`)

    await bot.press(A, `task:${task.id}:split`)
    expect(bot.lastText(A)).toContain('Как ты видишь задачу «Написать курсовую»? С чего хочется начать?')
    await bot.text(A, 'начну с требований, потом план')

    expect(llm.inputs).toEqual([{ task: 'Написать курсовую', answer: 'начну с требований, потом план', recent_context: [] }])
    expect(bot.lastText(A)).toBe(['Шаги по «Написать курсовую»:', '1. Перечитать требования', '2. Набросать план', '3. Написать введение', '', 'Начнём с первого?'].join('\n'))
    const steps = await prisma.task.findMany({ where: { userId: user.id, id: { not: task.id } }, orderBy: { createdAt: 'asc' } })
    expect(steps.map((step) => step.title)).toEqual(['Перечитать требования', 'Набросать план', 'Написать введение'])
    expect(await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).toMatchObject({ status: 'active' })
    expect(await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).toMatchObject({ pendingInput: 'none' })
    expect(await prisma.componentCall.count({ where: { name: 'task_breakdown', status: 'ok' } })).toBe(1)
    expect((await prisma.event.findFirstOrThrow({ where: { type: 'task_breakdown_done' } })).payload).toMatchObject({ mode: 'answered', steps: 3, llm_used: true })

    const first = steps.find((step) => step.title === 'Перечитать требования')!
    await bot.press(A, bot.lastButton(A, 'task:', ':start'))
    expect(await prisma.focusSession.findFirstOrThrow({ where: { userId: user.id, state: 'running' } })).toMatchObject({ taskId: first.id })
  })

  it('«Предложи сам» зовёт модель без ответа человека', async () => {
    const llm = breakdown(['Открыть черновик', 'Выписать три тезиса'])
    const bot = makeBot({ llm: llm.provider })
    const { task } = await taskCard(bot, A)

    await bot.press(A, `task:${task.id}:split`)
    await bot.press(A, `task:${task.id}:splitauto`)

    expect(llm.inputs).toEqual([{ task: 'Написать курсовую', answer: null, recent_context: [] }])
    expect(bot.lastText(A)).toContain('2. Выписать три тезиса')
    expect((await prisma.event.findFirstOrThrow({ where: { type: 'task_breakdown_done' } })).payload).toMatchObject({ mode: 'auto', llm_used: true })
  })

  it('без модели записывает перечисленные шаги, а на одну фразу просит список', async () => {
    const bot = makeBot()
    const { user, task } = await taskCard(bot, A)

    await bot.press(A, `task:${task.id}:split`)
    await bot.text(A, 'сначала разберусь с темой')
    expect(bot.lastText(A)).toBe('Не смог разобрать сам. Напиши шаги, каждый с новой строки, — запишу.')
    expect(await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).toMatchObject({ pendingInput: `task_split_manual:${task.id}` })

    await bot.text(A, '1. Выбрать тему\n2. Найти три источника')

    expect(bot.lastText(A)).toContain('1. Выбрать тему\n2. Найти три источника')
    expect(await prisma.task.count({ where: { userId: user.id } })).toBe(3)
    expect((await prisma.event.findFirstOrThrow({ where: { type: 'task_breakdown_done' } })).payload).toMatchObject({ mode: 'manual', steps: 2, llm_used: false })
    expect(await prisma.event.findFirst({ where: { type: 'llm_fallback', payload: { path: ['stage'], equals: 'breakdown' } } })).not.toBeNull()
  })

  it('ответ голосом тоже идёт в разбор, а не в список задач', async () => {
    const llm = breakdown(['Позвонить научруку', 'Согласовать тему'])
    const bot = makeBot({ llm: llm.provider, stt: { enabled: true, model: 'test-stt', async transcribe() { return 'сначала позвоню научруку' } } })
    bot.tg.downloads.set('voice-split', new Uint8Array([1, 2, 3]))
    const { task } = await taskCard(bot, A)

    await bot.press(A, `task:${task.id}:split`)
    await bot.voice(A, { fileId: 'voice-split', duration: 4, mimeType: 'audio/ogg', fileSize: 3 })

    expect(llm.inputs).toEqual([{ task: 'Написать курсовую', answer: 'сначала позвоню научруку', recent_context: [] }])
    expect(bot.lastText(A)).toContain('Шаги по «Написать курсовую»')
  })
})

// Модель разбора с заранее заданной последовательностью ответов.
const scriptedBreakdown = (answers: object[]) => {
  const inputs: { task: string; answer: string | null; recent_context: { role: string; text: string }[] }[] = []
  const provider: LlmProvider = {
    enabled: true,
    model: 'test-model',
    async complete(req) {
      if (!req.system.includes('разбить задачу пользователя')) throw new Error('unexpected LLM call')
      inputs.push(JSON.parse(req.input))
      const next = answers.shift()
      if (!next) throw new Error('лишний вызов модели')
      return reply(JSON.stringify(next))
    },
  }
  return { provider, inputs }
}

describe.skipIf(!hasDb)('разбор размытой задачи', () => {
  beforeEach(resetDb)

  it('на размытую задачу модель задаёт один вопрос и строит шаги с учётом ответа', async () => {
    const llm = scriptedBreakdown([{ question: 'Что должно получиться в итоге — текст, решение, созвон?' }, { steps: ['Выписать варианты переезда', 'Сравнить цены'] }])
    const bot = makeBot({ llm: llm.provider })
    await bot.onboard(A)
    const user = await prisma.user.findUniqueOrThrow({ where: { tgId: BigInt(A) } })
    const task = await prisma.task.create({ data: { userId: user.id, title: 'Разобраться с переездом' } })

    await bot.press(A, `task:${task.id}:split`)
    await bot.text(A, 'не знаю')
    expect(bot.lastText(A)).toBe('Что должно получиться в итоге — текст, решение, созвон?')
    expect(await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).toMatchObject({ pendingInput: `task_split_clarify:${task.id}` })

    await bot.text(A, 'решение, куда переезжать')

    expect(llm.inputs[1]).toMatchObject({ answer: 'решение, куда переезжать' })
    const context = llm.inputs[1]!.recent_context.map((item) => item.text)
    expect(context).toContain('не знаю')
    expect(context).toContain('Что должно получиться в итоге — текст, решение, созвон?')
    expect(context).not.toContain('решение, куда переезжать')
    expect(bot.lastText(A)).toContain('1. Выписать варианты переезда')
    expect(await prisma.event.count({ where: { type: 'task_breakdown_vague' } })).toBe(1)
  })

  it('если и после ответа неясно — второго вопроса нет, бот просит одно действие', async () => {
    const llm = scriptedBreakdown([{ question: 'Что должно получиться в итоге?' }, { question: 'А конкретнее?' }])
    const bot = makeBot({ llm: llm.provider })
    await bot.onboard(A)
    const user = await prisma.user.findUniqueOrThrow({ where: { tgId: BigInt(A) } })
    const task = await prisma.task.create({ data: { userId: user.id, title: 'Разобраться с жизнью' } })

    await bot.press(A, `task:${task.id}:split`)
    await bot.press(A, `task:${task.id}:splitauto`)
    await bot.text(A, 'сам не понимаю')
    expect(bot.lastText(A)).toBe('Пока не вижу, как это разбить. Назови одно действие, с которого можно начать за 10 минут, — запишу первым шагом.')
    expect(bot.textsTo(A)).not.toContain('А конкретнее?')

    await bot.text(A, 'Выписать, что бесит больше всего')

    expect(llm.inputs).toHaveLength(2)
    expect(bot.lastText(A)).toContain('1. Выписать, что бесит больше всего')
    const rounds = await prisma.event.findMany({ where: { type: 'task_breakdown_vague' }, orderBy: { id: 'asc' } })
    expect(rounds.map((event) => event.payload)).toEqual([{ task_id: task.id, round: 1 }, { task_id: task.id, round: 2 }])
    expect((await prisma.event.findFirstOrThrow({ where: { type: 'task_breakdown_done' } })).payload).toMatchObject({ mode: 'manual', steps: 1 })
  })
})

describe.skipIf(!hasDb)('короткий шаг внутри сессии', () => {
  beforeEach(resetDb)

  it('задача, закрытая раньше порога засчёта, не обрывает таймер', async () => {
    const bot = makeBot()
    await bot.onboard(A)
    const user = await prisma.user.findUniqueOrThrow({ where: { tgId: BigInt(A) } })
    const first = await prisma.task.create({ data: { userId: user.id, title: 'Открыть черновик' } })
    const second = await prisma.task.create({ data: { userId: user.id, title: 'Выписать тезисы' } })
    await bot.press(A, `task:${first.id}:start`)
    const started = await prisma.focusSession.findFirstOrThrow({ where: { userId: user.id, state: 'running' } })
    bot.advance(6)

    await bot.press(A, `task:${first.id}:done`)

    expect(await prisma.task.findUniqueOrThrow({ where: { id: first.id } })).toMatchObject({ status: 'done' })
    const running = await prisma.focusSession.findUniqueOrThrow({ where: { id: started.id } })
    expect(running).toMatchObject({ state: 'running', taskId: null })
    expect(running.plannedEndAt).toEqual(started.plannedEndAt)
    expect(bot.lastText(A)).toContain('«Открыть черновик» отметил готовой. Таймер идёт дальше до 10:40')
    expect(bot.lastText(A)).toContain('1. Выписать тезисы')
    expect(await prisma.event.count({ where: { type: 'session_completed' } })).toBe(0)

    await bot.press(A, `task:${second.id}:start`)
    expect(await prisma.focusSession.findUniqueOrThrow({ where: { id: started.id } })).toMatchObject({ state: 'running', taskId: second.id, startedAt: started.startedAt })
  })
})
