import { beforeEach, describe, expect, it } from 'vitest'
import type { LlmProvider } from '../llm/provider.js'
import type { SttProvider } from '../stt/provider.js'
import { makeBot } from '../test/bot.js'
import { hasDb, prisma, resetDb } from '../test/db.js'

const A = 2085
const B = 2086
const C = 2087

const llm = (answer: string): LlmProvider => ({
  enabled: true,
  async complete(req) {
    if (req.system.includes('сообщение пользователя фокус-боту')) return answer
    throw new Error('unexpected LLM call')
  },
})

const capture = llm(
  '{"kind":"capture","new_tasks":["Подготовить отчёт","Купить корм"],"complete_task":null,"start_task":null,"start_title":null}',
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
    const stt: SttProvider = { enabled: true, async transcribe() { return transcript } }
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
    const stt: SttProvider = { enabled: true, async transcribe() { return 'Сегодня хочу сделать отчёт и купить корм' } }
    const bot = makeBot({ llm: capture, stt })
    await bot.onboard(C)
    for (let i = 1; i <= 6; i++) {
      bot.tg.downloads.set(`voice-${i}`, new Uint8Array([i]))
      await bot.voice(C, { fileId: `voice-${i}`, duration: 10, mimeType: 'audio/ogg', fileSize: 1 })
    }

    expect(bot.tg.downloadRequests).toHaveLength(5)
    expect(bot.lastText(C)).toContain('до 5 голосовых')
  })

  it('явно завершает текущую задачу и сразу запускает следующую', async () => {
    const switchLlm = llm(
      '{"kind":"complete_and_start","new_tasks":[],"complete_task":"t1","start_task":"t2","start_title":null}',
    )
    const bot = makeBot({ llm: switchLlm })
    await bot.onboard(A)
    const user = await prisma.user.findUniqueOrThrow({ where: { tgId: BigInt(A) } })
    const first = await prisma.task.create({ data: { userId: user.id, title: 'Подготовить презентацию' } })
    const second = await prisma.task.create({ data: { userId: user.id, title: 'Позвонить Ивану' } })

    await bot.press(A, `task:${first.id}:start`)
    bot.advance(10)
    await bot.text(A, 'Эту сделал и приступаю к звонку Ивану')

    expect(await prisma.task.findUniqueOrThrow({ where: { id: first.id } })).toMatchObject({ status: 'done' })
    const finished = await prisma.focusSession.findFirstOrThrow({ where: { taskId: first.id } })
    expect(finished).toMatchObject({ state: 'finished', outcome: 'done', progress: 'moved', restChoice: 'continue' })
    const running = await prisma.focusSession.findFirstOrThrow({ where: { taskId: second.id, state: 'running' } })
    expect(running.intentText).toBe('Позвонить Ивану')
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
  })
})
