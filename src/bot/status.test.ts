import { beforeEach, describe, expect, it } from 'vitest'
import { makeBot } from '../test/bot.js'
import { hasDb, prisma, resetDb } from '../test/db.js'

const A = 3434

describe.skipIf(!hasDb)('Статус', () => {
  beforeEach(resetDb)

  it('до знакомства создаёт только технического пользователя для LLM-контекста', async () => {
    const bot = makeBot()
    await bot.textAs(A, '/status', {"text":"/status","route":"control","action":"status","value":null,"followUp":null})
    expect(bot.lastText(A)).toContain('Сейчас нет активной сессии или отдыха')
    expect(await prisma.user.count()).toBe(1)
  })

  it('показывает работу, задачу и превышение времени без изменения состояния', async () => {
    const bot = makeBot({ semanticRouterEnabled: true })
    await bot.setupOnboarded(A)
    await bot.textAs(A, 'Начать сессию', {"text":"Начать сессию","route":"control","action":"focus","value":null,"followUp":null})
    const session = await prisma.focusSession.findFirstOrThrow({ where: { state: 'running' } })
    const task = await prisma.task.create({ data: { userId: session.userId, title: 'Текущая задача' } })
    await prisma.focusSession.update({ where: { id: session.id }, data: { taskId: task.id, intentText: 'Старая задача' } })
    await prisma.user.update({ where: { id: session.userId }, data: { pendingInput: 'profile' } })
    const before = await prisma.focusSession.findUniqueOrThrow({ where: { id: session.id } })
    bot.advance(45)
    await bot.textAs(A, 'Статус', {"text":"Статус","route":"control","action":"status","value":null,"followUp":null})
    expect(bot.lastText(A)).toContain('Идёт рабочая сессия')
    expect(bot.lastText(A)).toContain('45 мин')
    expect(bot.lastText(A)).toContain('Текущая задача')
    expect(bot.lastText(A)).not.toContain('Старая задача')
    expect(bot.lastText(A)).toContain('Плановое время вышло')
    expect(await prisma.focusSession.findUniqueOrThrow({ where: { id: session.id } })).toEqual(before)
    expect((await prisma.user.findUniqueOrThrow({ where: { id: session.userId } })).pendingInput).toBe('profile')
    expect(await prisma.componentCall.count()).toBe(2)
    expect(bot.tg.sent.at(-1)?.replyKeyboard).toContainEqual(['Мои задачи', 'Статус'])
  })

  it('перерыв и возврат отсчитываются от текущего периода, не начала сессии', async () => {
    const bot = makeBot()
    await bot.setupOnboarded(A)
    await bot.textAs(A, 'Начать сессию', {"text":"Начать сессию","route":"control","action":"focus","value":null,"followUp":null})
    bot.advance(12)
    await bot.textAs(A, 'Перерыв', {"text":"Перерыв","route":"break","minutes":null,"durationSource":null,"followUp":null})
    bot.advance(7)
    await bot.textAs(A, '/status@my_focuse_bot', {"text":"/status@my_focuse_bot","route":"control","action":"status","value":null,"followUp":null})
    expect(bot.lastText(A)).toContain('Идёт отдых')
    expect(bot.lastText(A)).toContain('7 мин')
    expect(bot.lastText(A)).toContain('Задача не выбрана')
    await bot.textAs(A, 'Вернуться к работе', {"text":"Вернуться к работе","route":"continue_same","minutes":null,"durationSource":null,"followUp":null})
    bot.advance(3)
    await bot.textAs(A, '/status', {"text":"/status","route":"control","action":"status","value":null,"followUp":null})
    expect(bot.lastText(A)).toContain('Идёт рабочая сессия')
    expect(bot.lastText(A)).toContain('3 мин')
  })

  it('видит отдых после завершённой сессии по исходному событию', async () => {
    const bot = makeBot()
    await bot.setupOnboarded(A)
    const user = await prisma.user.findUniqueOrThrow({ where: { tgId: BigInt(A) } })
    await prisma.focusSession.updateMany({ where: { userId: user.id }, data: { state: 'cancelled' } })
    const session = await prisma.focusSession.create({ data: { userId: user.id, state: 'finished', restChoice: 'rest', finishedAt: bot.now(), intentText: 'План главы' } })
    bot.advance(5)
    await prisma.event.create({ data: { subjectId: user.subjectId, sessionId: session.id, type: 'rest_chosen', userRole: 'external', payload: { choice: 'rest' }, createdAt: bot.now(), dayKey: '2026-09-22' } })
    bot.advance(4)
    await bot.textAs(A, '/status', {"text":"/status","route":"control","action":"status","value":null,"followUp":null})
    expect(bot.lastText(A)).toContain('Идёт отдых')
    expect(bot.lastText(A)).toContain('4 мин')
    expect(bot.lastText(A)).toContain('Последняя задача: План главы')
  })

  it('считает время по открытому рабочему периоду и не сбрасывает выбор задачи', async () => {
    const bot = makeBot({ semanticRouterEnabled: true })
    await bot.setupOnboarded(A)
    await bot.textAs(A, 'Начать сессию', {"text":"Начать сессию","route":"control","action":"focus","value":null,"followUp":null})
    const session = await prisma.focusSession.findFirstOrThrow({ where: { state: 'running' } })
    bot.advance(15)
    await prisma.workPeriod.create({ data: { sessionId: session.id, startedAt: bot.now() } })
    await prisma.user.update({ where: { id: session.userId }, data: { pendingInput: `running_task_choice:${session.id}:12345678` } })
    await prisma.focusSession.update({ where: { id: session.id }, data: { pendingTaskTitle: 'Новая задача' } })
    bot.advance(2)
    await bot.textAs(A, '/status', {"text":"/status","route":"control","action":"status","value":null,"followUp":null})
    expect(bot.lastText(A)).toContain('2 мин')
    expect((await prisma.user.findUniqueOrThrow({ where: { id: session.userId } })).pendingInput).toBe(`running_task_choice:${session.id}:12345678`)
    expect((await prisma.focusSession.findUniqueOrThrow({ where: { id: session.id } })).pendingTaskTitle).toBe('Новая задача')
  })

  for (const ending of ['/today', 'stop', 'quiet'] as const) {
    it(`после отдыха корректно учитывает ${ending}`, async () => {
      const bot = makeBot()
      bot.ctx.remindersEnabled = true
      bot.ctx.reminderUserIds = [String(A)]
      await bot.setupOnboarded(A)
      const user = await prisma.user.findUniqueOrThrow({ where: { tgId: BigInt(A) } })
      await prisma.user.update({ where: { id: user.id }, data: { reminderPolicy: 1 } })
      await bot.textAs(A, 'Начать сессию', {"text":"Начать сессию","route":"control","action":"focus","value":null,"followUp":null})
      const session = await prisma.focusSession.findFirstOrThrow({ where: { userId: user.id, state: 'running' } })
      bot.advance(10)
      await bot.press(A, `out:${session.id}:done`)
      await bot.press(A, `skiprep:${session.id}:`)
      await bot.press(A, `rest:${session.id}:rest`)
      bot.advance(2)
      await bot.textAs(A, '/status', {"text":"/status","route":"control","action":"status","value":null,"followUp":null})
      expect(bot.lastText(A)).toContain('Идёт отдых')
      if (ending === '/today') await bot.textAs(A, ending, { route: 'close_day', text: ending, followUp: null })
      else await bot.press(A, `cycle::${ending}`)
      bot.advance(3)
      await bot.textAs(A, '/status', {"text":"/status","route":"control","action":"status","value":null,"followUp":null})
      expect(bot.lastText(A)).toContain(ending === 'quiet' ? 'Идёт отдых' : 'Сейчас нет активной сессии или отдыха')
      if (ending === 'quiet') expect(bot.lastText(A)).toContain('5 мин')
      else {
        expect((await prisma.focusSession.findUniqueOrThrow({ where: { id: session.id } })).restEndedAt).not.toBeNull()
        // До релиза старые данные не имели restEndedAt: журнал тоже закрывает отдых.
        await prisma.focusSession.update({ where: { id: session.id }, data: { restEndedAt: null } })
        await bot.textAs(A, '/status', {"text":"/status","route":"control","action":"status","value":null,"followUp":null})
        expect(bot.lastText(A)).toContain('Сейчас нет активной сессии или отдыха')
      }
    })
  }

  it('не видит чужую сессию и не объявляет законченный отдых активным', async () => {
    const bot = makeBot()
    await bot.setupOnboarded(A)
    await bot.textAs(A, 'Начать сессию', {"text":"Начать сессию","route":"control","action":"focus","value":null,"followUp":null})
    await bot.textAs(A + 1, '/status', {"text":"/status","route":"control","action":"status","value":null,"followUp":null})
    expect(bot.lastText(A + 1)).toContain('Сейчас нет активной сессии или отдыха')
    const user = await prisma.user.findUniqueOrThrow({ where: { tgId: BigInt(A) } })
    await prisma.focusSession.updateMany({ where: { userId: user.id }, data: { state: 'finished', restChoice: 'rest', restEndedAt: bot.now() } })
    await bot.textAs(A, '/status', {"text":"/status","route":"control","action":"status","value":null,"followUp":null})
    expect(bot.lastText(A)).toContain('Сейчас нет активной сессии или отдыха')
  })

  it('не теряет номер задачи после справочного статуса и обновляет старую клавиатуру', async () => {
    const bot = makeBot()
    await bot.setupOnboarded(A)
    const user = await prisma.user.findUniqueOrThrow({ where: { tgId: BigInt(A) } })
    await prisma.task.create({ data: { userId: user.id, title: 'Проверить текст' } })
    await bot.textAs(A, 'Мои задачи', {"text":"Мои задачи","route":"control","action":"tasks","value":null,"followUp":null})
    await bot.textAs(A, '/status', {"text":"/status","route":"control","action":"status","value":null,"followUp":null})
    expect(bot.tg.sent.at(-1)?.replyKeyboard).toContainEqual(['Мои задачи', 'Статус'])
    await bot.textAs(A, '1', {route: 'task_action', text: '1', action: 'number', number: 1, task: null, followUp: null})
    expect(bot.lastText(A)).toContain('Проверить текст')
    expect(await prisma.task.count({ where: { userId: user.id } })).toBe(1)
  })

})
