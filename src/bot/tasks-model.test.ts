import { beforeEach, describe, expect, it } from 'vitest'
import type { LlmProvider } from '../llm/provider.js'
import { makeBot } from '../test/bot.js'
import { hasDb, prisma, resetDb } from '../test/db.js'

// Задачи — одна модель: одно место создания, большая задача сохраняется,
// шаги разбора связаны с исходной. Сценарии — из аудита логики 01.10.
const A = 5401

const user = () => prisma.user.findUniqueOrThrow({ where: { tgId: BigInt(A) } })
const reply = (text: string) => ({ text, usage: null })

function llm(handlers: { tasks?: (text: string) => string; intent?: (intent: string) => string; breakdown?: () => string }): LlmProvider {
  return {
    enabled: true,
    model: 'test-model',
    async complete(req) {
      const input = JSON.parse(req.input)
      if (req.system.includes('сообщение пользователя фокус-боту') && handlers.tasks) return reply(handlers.tasks(input.text))
      if (req.system.includes('намерение пользователя перед рабочей сессией') && handlers.intent) return reply(handlers.intent(input.intent))
      if (req.system.includes('разбить задачу пользователя') && handlers.breakdown) return reply(handlers.breakdown())
      throw new Error('unexpected LLM call')
    },
  }
}
const intentOnly = '{"kind":"session_intent","new_tasks":[],"start_title":null}'

describe.skipIf(!hasDb)('задачи — одна модель', () => {
  beforeEach(resetDb)

  it('старт с тем же названием не создаёт дубль', async () => {
    const bot = makeBot({ llm: llm({ tasks: () => intentOnly, intent: () => '{"task":null,"title":"Сделать слайды","scope":"step"}' }) })
    await bot.onboard(A)
    const u = await user()
    await prisma.task.create({ data: { userId: u.id, title: 'Сделать слайды' } })

    await bot.text(A, 'поработаю над слайдами')
    await bot.press(A, bot.lastButton(A, 'len:', ':ok'))

    expect(await prisma.task.count({ where: { userId: u.id } })).toBe(1)
  })

  it('большая задача сохраняется, а сессия — её первый шаг', async () => {
    const bot = makeBot({ llm: llm({ tasks: () => intentOnly, intent: () => '{"task":null,"title":"Написать диплом","scope":"multi_session"}' }) })
    await bot.onboard(A)
    const u = await user()

    await bot.text(A, 'написать диплом')
    expect(bot.lastText(A)).toContain('на несколько заходов')
    await bot.text(A, 'составить план')
    await bot.press(A, bot.lastButton(A, 'len:', ':ok'))

    const tasks = await prisma.task.findMany({ where: { userId: u.id } })
    expect(tasks.map((t) => t.title)).toEqual(['Написать диплом'])
    expect(await prisma.focusSession.findFirstOrThrow({ where: { state: 'running' } })).toMatchObject({ taskId: tasks[0]!.id, intentText: 'составить план' })
  })

  it('«Начать сессию» после написанного намерения — это «Ок», а не стирание', async () => {
    const bot = makeBot()
    await bot.onboard(A)
    await bot.text(A, 'отчёт')
    expect(bot.lastText(A)).toContain('Давай')

    await bot.text(A, 'Начать сессию')

    expect(await prisma.focusSession.findFirstOrThrow({ where: { state: 'running' } })).toMatchObject({ intentText: 'отчёт' })
  })

  it('обещанные «10 минут» после «не получается начать» действуют и при выборе задачи кнопкой', async () => {
    const bot = makeBot()
    await bot.onboard(A)
    const u = await user()
    const task = await prisma.task.create({ data: { userId: u.id, title: 'Эссе' } })
    await bot.text(A, '/stop')
    await bot.press(A, 'dec::stuck')

    await bot.press(A, `task:${task.id}:start`)

    expect(await prisma.focusSession.findFirstOrThrow({ where: { state: 'running' } })).toMatchObject({ plannedMinutes: 10, taskId: task.id })
  })

  it('после «Готово» можно закрыть задачу целиком одной кнопкой', async () => {
    const bot = makeBot()
    await bot.onboard(A)
    const u = await user()
    const task = await prisma.task.create({ data: { userId: u.id, title: 'Эссе' } })
    await bot.press(A, `task:${task.id}:start`)
    const s = await prisma.focusSession.findFirstOrThrow({ where: { state: 'running' } })
    bot.advance(40)
    await bot.press(A, `out:${s.id}:done`)
    await bot.press(A, `skiprep:${s.id}:`)

    expect(await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).toMatchObject({ status: 'active' })
    await bot.press(A, bot.lastButton(A, `task:${task.id}:done`))
    expect(await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).toMatchObject({ status: 'done' })
  })

  it('«эту закончил» после конца сессии закрывает задачу этой сессии', async () => {
    const bot = makeBot({ llm: llm({ tasks: () => '{"kind":"complete_task","new_tasks":[],"start_title":null,"complete_title":null}' }) })
    await bot.onboard(A)
    const u = await user()
    const task = await prisma.task.create({ data: { userId: u.id, title: 'Эссе' } })
    await bot.press(A, `task:${task.id}:start`)
    const s = await prisma.focusSession.findFirstOrThrow({ where: { state: 'running' } })
    bot.advance(40)
    await bot.press(A, `out:${s.id}:not_done`)
    await bot.press(A, `skiprep:${s.id}:`)
    await bot.press(A, `rest:${s.id}:rest`)

    await bot.text(A, 'эту закончил')

    expect(await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).toMatchObject({ status: 'done' })
    expect(bot.lastText(A)).not.toContain('Не понял')
  })
})

describe.skipIf(!hasDb)('шаги разбора связаны с исходной задачей', () => {
  beforeEach(resetDb)

  it('в списке шаги под исходной; повторный разбор заменяет незакрытые; после последнего — закрыть исходную', async () => {
    let steps = ['Открыть черновик', 'Выписать тезисы']
    const bot = makeBot({ llm: llm({ breakdown: () => JSON.stringify({ steps }) }) })
    await bot.onboard(A)
    const u = await user()
    const parent = await prisma.task.create({ data: { userId: u.id, title: 'Курсовая', createdAt: new Date('2026-09-20T10:00:00Z') } })
    await prisma.task.create({ data: { userId: u.id, title: 'Позвонить маме', createdAt: new Date('2026-09-20T11:00:00Z') } })

    await bot.press(A, `task:${parent.id}:split`)
    await bot.press(A, `task:${parent.id}:splitauto`)
    await bot.text(A, '/tasks')
    expect(bot.lastText(A)).toContain(['1. Курсовая', '2. ↳ Открыть черновик (шаг 1 из 2)', '3. ↳ Выписать тезисы (шаг 2 из 2)', '4. Позвонить маме'].join('\n'))

    steps = ['Найти три источника']
    await bot.press(A, `task:${parent.id}:split`)
    await bot.press(A, `task:${parent.id}:splitauto`)
    const active = await prisma.task.findMany({ where: { userId: u.id, parentId: parent.id, status: 'active' } })
    expect(active.map((t) => t.title)).toEqual(['Найти три источника'])

    await bot.press(A, `task:${active[0]!.id}:done`)
    expect(bot.lastText(A)).toBe('Все шаги «Курсовая» готовы. Закрыть и саму задачу?')
    await bot.press(A, bot.lastButton(A, `task:${parent.id}:done`))
    expect(await prisma.task.findUniqueOrThrow({ where: { id: parent.id } })).toMatchObject({ status: 'done' })
  })

  it('«Добавить задачу»: больше 10 строк — говорит, что записал первые 10; повтор — «уже есть»', async () => {
    const bot = makeBot()
    await bot.onboard(A)
    await bot.press(A, 'tasks::add')
    await bot.text(A, Array.from({ length: 12 }, (_, i) => `Задача ${i + 1}`).join('\n'))
    expect(await prisma.task.count({ where: { userId: (await user()).id } })).toBe(10)
    expect(bot.lastText(A)).toContain('Записал первые 10')

    await bot.press(A, 'tasks::add')
    await bot.text(A, 'Задача 1')
    expect(bot.lastText(A)).toContain('«Задача 1» уже есть в списке.')
  })
})

describe.skipIf(!hasDb)('тексты совпадают с поведением', () => {
  beforeEach(resetDb)

  it('«Сменить задачу» после отчёта не говорит «Таймер уже идёт» и запускает выбранную', async () => {
    const bot = makeBot()
    await bot.onboard(A)
    const u = await user()
    const task = await prisma.task.create({ data: { userId: u.id, title: 'Эссе' } })
    await bot.text(A, 'глава, 40 минут')
    const s = await prisma.focusSession.findFirstOrThrow({ where: { state: 'running' } })
    bot.advance(40)
    await bot.press(A, `out:${s.id}:done`)
    await bot.press(A, `skiprep:${s.id}:`)
    expect(bot.lastText(A)).toMatch(/^Отдохнёшь/)
    // Кнопки продолжения появляются, когда разбор отчёта предложил продолжить.
    await prisma.focusSession.update({ where: { id: s.id }, data: { continueSuggested: true } })

    await bot.press(A, `again:${s.id}:change`)
    expect(bot.lastText(A)).not.toContain('Таймер уже идёт')
    await bot.press(A, bot.lastButton(A, `task:${task.id}:start`))
    expect(await prisma.focusSession.findFirstOrThrow({ where: { state: 'running' } })).toMatchObject({ taskId: task.id })
  })

  it('свободная техника: без «Короче/Длиннее» и без обещания заглянуть при выключенных пингах', async () => {
    const bot = makeBot()
    await bot.onboard(A)
    await prisma.user.update({ where: { id: (await user()).id }, data: { technique: 'free', pingsEnabled: false } })
    await bot.text(A, 'глава')
    expect(bot.lastText(A)).toBe('Без таймера. Начинаем? Закончишь — /done.')
    expect(bot.buttons(A).some((b) => b.data.endsWith(':down'))).toBe(false)
  })
})
