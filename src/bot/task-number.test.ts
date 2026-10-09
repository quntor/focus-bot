import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeBot } from '../test/bot.js'
import { hasDb, prisma, resetDb } from '../test/db.js'
import { showTaskPicker, showTasks } from './tasks.js'
import { reply } from './context.js'
import { clearConversationContext } from './conversation-context.js'
import { enqueue } from '../outbox/queue.js'
import { runOutboxOnce } from '../outbox/worker.js'
import { taskNumberPrompt } from './task-number-prompt.js'
import { T } from './texts.js'

const A = 2828
describe.skipIf(!hasDb)('номер показанной задачи', () => {
  beforeEach(resetDb)
  it('открывает вторую задачу до LLM и сохраняет работающий таймер', async () => {
    const complete = vi.fn(async () => ({ text: '{"route":"unclear","text":"2","followUp":null}', usage: null }))
    const bot = makeBot({ semanticRouterEnabled: true, llm: { enabled: true, model: 'test', complete } })
    await bot.setupOnboarded(A)
    const user = await prisma.user.findUniqueOrThrow({ where: { tgId: BigInt(A) } })
    await prisma.task.create({ data: { userId: user.id, title: 'Первая', createdAt: new Date('2026-01-01') } })
    const second = await prisma.task.create({ data: { userId: user.id, title: 'Вторая', createdAt: new Date('2026-01-02') } })
    await bot.textAs(A, 'Начать сессию', {"text":"Начать сессию","route":"control","action":"focus","value":null,"followUp":null})
    const before = await prisma.focusSession.findFirstOrThrow({ where: { userId: user.id } })
    await bot.textAs(A, 'Мои задачи', { text: 'Мои задачи', route: 'control', action: 'tasks', value: null, followUp: null })
    complete.mockClear()
    await bot.textAs(A, '2', {"text":"2","route":"task_action","action":"number","number":2,"task":null,"followUp":null})
    expect(bot.lastText(A)).toContain('Задача: «Вторая»')
    expect(complete).not.toHaveBeenCalled()
    expect(bot.buttons(A)).toContainEqual({ text: '▶️ Начать', data: `task:${second.id}:start` })
    const after = await prisma.focusSession.findUniqueOrThrow({ where: { id: before.id } })
    expect(after).toMatchObject({ taskId: null, startedAt: before.startedAt, plannedEndAt: before.plannedEndAt })
    await bot.press(A, `task:${second.id}:start`)
    expect(await prisma.focusSession.findUniqueOrThrow({ where: { id: before.id } })).toMatchObject({ taskId: second.id, plannedEndAt: before.plannedEndAt })
  })

  async function listed(count = 3) {
    const bot = makeBot()
    await bot.setupOnboarded(A)
    const user = await prisma.user.findUniqueOrThrow({ where: { tgId: BigInt(A) } })
    const tasks = []
    for (let i = 0; i < count; i++) tasks.push(await prisma.task.create({ data: { userId: user.id, title: `Дело ${i + 1}`, createdAt: new Date(Date.UTC(2026, 0, 1, 0, i)) } }))
    await bot.textAs(A, 'Мои задачи', {"text":"Мои задачи","route":"control","action":"tasks","value":null,"followUp":null})
    return { bot, user, tasks }
  }

  it('выбирает показанный ID после изменения порядка и очистки памяти процесса', async () => {
    const { bot, tasks } = await listed()
    await prisma.task.update({ where: { id: tasks[0]!.id }, data: { status: 'dropped' } })
    clearConversationContext()
    const restarted = makeBot({ now: bot.now() })
    await restarted.textAs(A, '2', {"text":"2","route":"task_action","action":"number","number":2,"task":null,"followUp":null})
    expect(restarted.lastText(A)).toContain('Задача: «Дело 2»')
  })

  it('не подменяет удалённую вторую задачу следующей', async () => {
    const { bot, tasks } = await listed()
    await prisma.task.update({ where: { id: tasks[1]!.id }, data: { status: 'dropped' } })
    await bot.textAs(A, '2', {"text":"2","route":"task_action","action":"number","number":2,"task":null,"followUp":null})
    expect(bot.lastText(A)).not.toContain('Задача: «Дело 3»')
    expect(await prisma.task.count()).toBe(3)
  })

  it('использует глобальный номер на второй странице и сохраняет кнопку возврата', async () => {
    const { bot } = await listed(8)
    await bot.press(A, 'tasks::p1')
    await bot.textAs(A, '8', {"text":"8","route":"task_action","action":"number","number":8,"task":null,"followUp":null})
    expect(bot.lastText(A)).toContain('Задача: «Дело 8»')
    expect(bot.tg.sent.at(-1)?.keyboard?.flat().some((b) => b.data === 'tasks::p1')).toBe(true)
  })

  it('LLM уточняет отсутствующий номер и позволяет исправить ответ', async () => {
    const { bot } = await listed()
    await bot.textAs(A, '99', {"text":"99","route":"clarify","question":"Такого номера нет. Выбери задачу из списка.","followUp":null})
    expect(bot.lastText(A)).toContain('Выбери задачу из списка')
    await bot.textAs(A, '2', {"text":"2","route":"task_action","action":"number","number":2,"task":null,"followUp":null})
    expect(bot.lastText(A)).toContain('Задача: «Дело 2»')
  })

  it('в списке непосредственного старта номер делает то же, что кнопка', async () => {
    const { bot, user, tasks } = await listed()
    await showTaskPicker(bot.ctx, user, 'Выбери задачу')
    await bot.textAs(A, '2', {"text":"2","route":"task_action","action":"number","number":2,"task":null,"followUp":null})
    expect(await prisma.focusSession.findFirstOrThrow({ where: { userId: user.id, state: 'running' } })).toMatchObject({ taskId: tasks[1]!.id })
  })

  it('не перехватывает число после нового вопроса о длительности', async () => {
    const { bot, user } = await listed()
    await bot.textAs(A, 'Начать сессию', {"text":"Начать сессию","route":"control","action":"focus","value":null,"followUp":null})
    const session = await prisma.focusSession.findFirstOrThrow({ where: { userId: user.id, state: 'running' } })
    await prisma.user.update({ where: { id: user.id }, data: { pendingInput: `running_duration:${session.id}` } })
    await reply(bot.ctx, user, 'Сколько минут?')
    await bot.textAs(A, '2', {route: 'clarify', text: '2', question: 'Не понял длительность: нужно от 10 минут.', followUp: null})
    expect(bot.lastText(A)).toContain('Не понял длительность')
    expect(bot.lastText(A)).not.toContain('Задача: «Дело 2»')
    await bot.textAs(A, '20 минут', {"text":"20 минут","route":"answer_pending","answer":{"kind":"duration","minutes":20},"followUp":null})
    expect(await prisma.focusSession.findUniqueOrThrow({ where: { id: session.id } })).toMatchObject({ plannedMinutes: 20 })
  })

  it('не меняет ожидание отчёта при просмотре задач', async () => {
    const { bot, user } = await listed()
    await prisma.user.update({ where: { id: user.id }, data: { pendingInput: 'report_text' } })
    await showTasks(bot.ctx, { ...user, pendingInput: 'report_text' })
    await bot.textAs(A, '2', {"text":"2","route":"task_action","action":"number","number":2,"task":null,"followUp":null})
    expect(bot.lastText(A)).toContain('Задача: «Дело 2»')
    expect(await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).toMatchObject({ pendingInput: 'report_text' })
  })

  it('не интерпретирует номер списка другого пользователя', async () => {
    const { bot } = await listed()
    await bot.setupOnboarded(A + 1)
    await bot.textAs(A + 1, '2', {"text":"2","route":"task_action","action":"number","number":2,"task":null,"followUp":null})
    expect(bot.lastText(A + 1)).not.toContain('Дело 2')
  })

  it('выбирает по расшифрованному голосу, не теряя список из-за эха', async () => {
    const { bot } = await listed()
    bot.ctx.llm = { enabled: true, model: 'number-test', async complete() { return { text: JSON.stringify({route:'task_action',text:'2',action:'number',number:2,task:null,followUp:null}), usage:null } } }
    bot.ctx.stt = { enabled: true, model: 'test', async transcribe() { return '2' } }
    bot.tg.downloads.set('number', new Uint8Array([1, 2, 3]))
    await bot.voice(A, { fileId: 'number', duration: 1 })
    expect(bot.textsTo(A).at(-2)).toContain('Распознал:')
    expect(bot.lastText(A)).toContain('Задача: «Дело 2»')
  })

  it('не перехватывает число после обычного ответа бота или истечения TTL', async () => {
    const { bot, user } = await listed()
    await reply(bot.ctx, user, 'Работаем дальше')
    await bot.textAs(A, '2', {"text":"2","route":"task_action","action":"number","number":2,"task":null,"followUp":null})
    expect(bot.lastText(A)).not.toContain('Задача: «Дело 2»')
    await showTasks(bot.ctx, user)
    bot.advance(361)
    await bot.textAs(A, '2', {"text":"2","route":"task_action","action":"number","number":2,"task":null,"followUp":null})
    expect(bot.lastText(A)).not.toContain('Задача: «Дело 2»')
  })

  it('сохраняет список актуального утреннего приглашения без фиктивной подготовки', async () => {
    const { bot, user, tasks } = await listed()
    await prisma.focusSession.deleteMany({ where: { userId: user.id } })
    await prisma.user.update({ where: { id: user.id }, data: { pendingInput: 'none' } })
    await enqueue(prisma, { userId: user.id, kind: 'meeting', key: 'sber28:morning', sendAfter: bot.now(), payload: { defaulted: false, morning: true } })
    await runOutboxOnce(bot.ctx)
    await bot.textAs(A, '2', {"text":"2","route":"task_action","action":"number","number":2,"task":null,"followUp":null})
    expect(await prisma.focusSession.findFirstOrThrow({ where: { userId: user.id, state: 'running' } })).toMatchObject({ taskId: tasks[1]!.id })
  })

  it('сопоставляет номера итогового списка, а не префикса с новыми задачами', async () => {
    const { bot, user } = await listed()
    await showTasks(bot.ctx, user, 0, T.tasksCaptured(['Дело 2', 'Дело 3']))
    await bot.textAs(A, '2', {"text":"2","route":"task_action","action":"number","number":2,"task":null,"followUp":null})
    expect(bot.lastText(A)).toContain('Задача: «Дело 2»')
  })

  it('не принимает кнопку «начать с первого» за выбор последнего номера шагов', async () => {
    const { bot, user, tasks } = await listed()
    await reply(bot.ctx, user, T.breakdownDone('Исходная', ['Первый шаг', 'Второй шаг']), [
      [{ text: T.breakdownStartFirst, data: `task:${tasks[0]!.id}:start` }],
      [{ text: T.tasksButton, data: 'tasks::p0' }],
    ])
    expect(await taskNumberPrompt(bot.ctx, user.id)).toBeNull()
  })

  it('поддерживает сокращённые подписи длинных задач', async () => {
    const { bot, user, tasks } = await listed()
    const title = 'Очень длинная задача '.repeat(4)
    await prisma.task.update({ where: { id: tasks[1]!.id }, data: { title } })
    await showTasks(bot.ctx, user)
    await bot.textAs(A, '2', {"text":"2","route":"task_action","action":"number","number":2,"task":null,"followUp":null})
    expect(bot.lastText(A)).toContain(`Задача: «${title}»`)
  })

  it('новый вопрос из воркера закрывает старый список; события не содержат названий', async () => {
    const { bot, user } = await listed()
    await bot.textAs(A, 'Начать сессию', {"text":"Начать сессию","route":"control","action":"focus","value":null,"followUp":null})
    await bot.textAs(A, 'Мои задачи', { text: 'Мои задачи', route: 'control', action: 'tasks', value: null, followUp: null })
    expect(await taskNumberPrompt(bot.ctx, user.id)).not.toBeNull()
    bot.advance(20)
    await runOutboxOnce(bot.ctx)
    expect(await taskNumberPrompt(bot.ctx, user.id)).toBeNull()
    const events = await prisma.event.findMany({ where: { type: 'task_number_prompt' } })
    expect(events.every((event) => !event.isUserAction)).toBe(true)
    expect(JSON.stringify(events.map((event) => event.payload))).not.toContain('Дело')
  })
})
