import { beforeEach, describe, expect, it } from 'vitest'
import { makeBot } from '../test/bot.js'
import { hasDb, prisma, resetDb } from '../test/db.js'

const A = 3434

describe.skipIf(!hasDb)('Статус', () => {
  beforeEach(resetDb)

  it('до знакомства не создаёт пользователя', async () => {
    const bot = makeBot()
    await bot.text(A, '/status')
    expect(bot.lastText(A)).toContain('Сейчас нет активной сессии или отдыха')
    expect(await prisma.user.count()).toBe(0)
  })

  it('показывает работу, задачу и превышение времени без изменения состояния', async () => {
    const bot = makeBot({ semanticRouterEnabled: true })
    await bot.onboard(A)
    await bot.text(A, 'Начать сессию')
    const session = await prisma.focusSession.findFirstOrThrow({ where: { state: 'running' } })
    const task = await prisma.task.create({ data: { userId: session.userId, title: 'Текущая задача' } })
    await prisma.focusSession.update({ where: { id: session.id }, data: { taskId: task.id, intentText: 'Старая задача' } })
    await prisma.user.update({ where: { id: session.userId }, data: { pendingInput: 'profile' } })
    const before = await prisma.focusSession.findUniqueOrThrow({ where: { id: session.id } })
    bot.advance(45)
    await bot.text(A, 'Статус')
    expect(bot.lastText(A)).toContain('Идёт рабочая сессия')
    expect(bot.lastText(A)).toContain('45 мин')
    expect(bot.lastText(A)).toContain('Текущая задача')
    expect(bot.lastText(A)).not.toContain('Старая задача')
    expect(bot.lastText(A)).toContain('Плановое время вышло')
    expect(await prisma.focusSession.findUniqueOrThrow({ where: { id: session.id } })).toEqual(before)
    expect((await prisma.user.findUniqueOrThrow({ where: { id: session.userId } })).pendingInput).toBe('profile')
    expect(await prisma.componentCall.count()).toBe(0)
    expect(bot.tg.sent.at(-1)?.replyKeyboard).toContainEqual(['Мои задачи', 'Статус'])
  })

  it('перерыв и возврат отсчитываются от текущего периода, не начала сессии', async () => {
    const bot = makeBot()
    await bot.onboard(A)
    await bot.text(A, 'Начать сессию')
    bot.advance(12)
    await bot.text(A, 'Перерыв')
    bot.advance(7)
    await bot.text(A, '/status@my_focuse_bot')
    expect(bot.lastText(A)).toContain('Идёт отдых')
    expect(bot.lastText(A)).toContain('7 мин')
    expect(bot.lastText(A)).toContain('Задача не выбрана')
    await bot.text(A, 'Вернуться к работе')
    bot.advance(3)
    await bot.text(A, '/status')
    expect(bot.lastText(A)).toContain('Идёт рабочая сессия')
    expect(bot.lastText(A)).toContain('3 мин')
  })

  it('видит отдых после завершённой сессии по исходному событию', async () => {
    const bot = makeBot()
    await bot.onboard(A)
    const user = await prisma.user.findUniqueOrThrow({ where: { tgId: BigInt(A) } })
    await prisma.focusSession.updateMany({ where: { userId: user.id }, data: { state: 'cancelled' } })
    const session = await prisma.focusSession.create({ data: { userId: user.id, state: 'finished', restChoice: 'rest', finishedAt: bot.now(), intentText: 'План главы' } })
    bot.advance(5)
    await prisma.event.create({ data: { subjectId: user.subjectId, sessionId: session.id, type: 'rest_chosen', userRole: 'external', payload: { choice: 'rest' }, createdAt: bot.now(), dayKey: '2026-09-22' } })
    bot.advance(4)
    await bot.text(A, '/status')
    expect(bot.lastText(A)).toContain('Идёт отдых')
    expect(bot.lastText(A)).toContain('4 мин')
    expect(bot.lastText(A)).toContain('Последняя задача: План главы')
  })

  it('считает время по открытому рабочему периоду и не сбрасывает выбор задачи', async () => {
    const bot = makeBot({ semanticRouterEnabled: true })
    await bot.onboard(A)
    await bot.text(A, 'Начать сессию')
    const session = await prisma.focusSession.findFirstOrThrow({ where: { state: 'running' } })
    bot.advance(15)
    await prisma.workPeriod.create({ data: { sessionId: session.id, startedAt: bot.now() } })
    await prisma.user.update({ where: { id: session.userId }, data: { pendingInput: `running_task_choice:${session.id}:12345678` } })
    await prisma.focusSession.update({ where: { id: session.id }, data: { pendingTaskTitle: 'Новая задача' } })
    bot.advance(2)
    await bot.text(A, '/status')
    expect(bot.lastText(A)).toContain('2 мин')
    expect((await prisma.user.findUniqueOrThrow({ where: { id: session.userId } })).pendingInput).toBe(`running_task_choice:${session.id}:12345678`)
    expect((await prisma.focusSession.findUniqueOrThrow({ where: { id: session.id } })).pendingTaskTitle).toBe('Новая задача')
  })

  it('не видит чужую сессию и не объявляет законченный отдых активным', async () => {
    const bot = makeBot()
    await bot.onboard(A)
    await bot.text(A, 'Начать сессию')
    await bot.text(A + 1, '/status')
    expect(bot.lastText(A + 1)).toContain('Сейчас нет активной сессии или отдыха')
    const user = await prisma.user.findUniqueOrThrow({ where: { tgId: BigInt(A) } })
    await prisma.focusSession.updateMany({ where: { userId: user.id }, data: { state: 'finished', restChoice: 'rest', restEndedAt: bot.now() } })
    await bot.text(A, '/status')
    expect(bot.lastText(A)).toContain('Сейчас нет активной сессии или отдыха')
  })

  it('не теряет номер задачи после справочного статуса и обновляет старую клавиатуру', async () => {
    const bot = makeBot()
    await bot.onboard(A)
    const user = await prisma.user.findUniqueOrThrow({ where: { tgId: BigInt(A) } })
    await prisma.task.create({ data: { userId: user.id, title: 'Проверить текст' } })
    await bot.text(A, 'Мои задачи')
    await bot.text(A, '/status')
    expect(bot.tg.sent.at(-1)?.replyKeyboard).toContainEqual(['Мои задачи', 'Статус'])
    await bot.text(A, '1')
    expect(bot.lastText(A)).toContain('Проверить текст')
    expect(await prisma.task.count({ where: { userId: user.id } })).toBe(1)
  })

})
