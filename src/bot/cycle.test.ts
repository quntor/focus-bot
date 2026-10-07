import { beforeEach, describe, expect, it } from 'vitest'
import { hasDb, prisma, resetDb } from '../test/db.js'
import { makeBot } from '../test/bot.js'
import { runOutboxOnce } from '../outbox/worker.js'
import { scriptedModel, work } from '../test/semantic-provider.js'

const A = 1001

describe.skipIf(!hasDb)('полный цикл сессии', () => {
  beforeEach(resetDb)

  it('знакомство → намерение → предложение → пинг → исход → отчёт → отдых', async () => {
    const bot = makeBot()
    await bot.setupOnboarded(A)
    expect(bot.lastText(A)).toContain('С чего начнёшь?')

    const user = await prisma.user.findUniqueOrThrow({ where: { tgId: BigInt(A) } })
    expect(user.consentAt).toBeNull()
    expect(user.timezone).toBe('Europe/Moscow')

    await bot.textAs(A, 'набросать план главы', {"text":"набросать план главы","route":"new_task","intent":{"task":null,"title":"набросать план главы","scope":"step"},"minutes":null,"durationSource":null,"followUp":null})
    expect(bot.lastText(A)).toBe('Давай 40 минут работы, потом 10 отдыха.')
    await bot.press(A, bot.lastButton(A, 'len:', ':ok'))
    expect(bot.lastText(A)).toContain('Поехали')

    const session = await prisma.focusSession.findFirstOrThrow({ where: { userId: user.id } })
    expect(session.state).toBe('running')
    expect(session.plannedMinutes).toBe(40)
    expect(session.minutesSource).toBe('bot')

    bot.advance(20)
    await runOutboxOnce(bot.ctx)
    expect(bot.lastText(A)).toBe('На месте?')
    await bot.press(A, bot.lastButton(A, 'ping:', ':here'))

    bot.advance(20)
    await runOutboxOnce(bot.ctx)
    expect(bot.lastText(A)).toBe('Время вышло: поработай ещё или пора отдыхать?')
    await bot.press(A, `out:${session.id}:done`)
    expect(bot.lastText(A)).toContain('Пара слов')

    await bot.textAs(A, 'план готов, дальше введение', { route: 'report', text: 'план готов, дальше введение', report: { route: 'report', progress: 'moved', next_step: 'введение', continue_now: false, continue_minutes: null, allocations: [] }, followUp: null })
    expect(bot.lastText(A)).toBe('Записал. Отдохнёшь 10 минут?')
    await bot.press(A, `rest:${session.id}:rest`)
    expect(bot.lastText(A)).toContain('Отдыхай')

    bot.advance(10)
    await runOutboxOnce(bot.ctx)
    expect(bot.lastText(A)).toBe('Отдых закончился. С чего продолжишь?')

    const done = await prisma.focusSession.findUniqueOrThrow({ where: { id: session.id } })
    expect(done.state).toBe('finished')
    expect(done.outcome).toBe('done')
    expect(done.counted).toBe(true)
    expect(done.reportText).toBe('план готов, дальше введение')
    const points = await prisma.pointsEntry.findMany({ where: { userId: user.id } })
    expect(points.map((p) => [p.reason, p.amount])).toEqual([['session_completed', 10]])
    const streak = await prisma.streak.findUniqueOrThrow({ where: { userId: user.id } })
    expect(streak.current).toBe(1)
  })

  it('названное время принимается без переспрашивания', async () => {
    const bot = makeBot()
    await bot.setupOnboarded(A)
    await bot.textAs(A, 'допишу раздел, за час', {"text":"допишу раздел, за час","route":"new_task","intent":{"task":null,"title":"допишу раздел","scope":"step"},"minutes":60,"durationSource":"за час","followUp":null})
    expect(bot.lastText(A)).toContain('Час работы, потом 10 отдыха')
    const s = await prisma.focusSession.findFirstOrThrow({})
    expect(s.state).toBe('running')
    expect(s.plannedMinutes).toBe(60)
    expect(s.minutesSource).toBe('user')
  })

  it('«всё, на сегодня» — итог дня и назначение встречи, не тишина', async () => {
    const bot = makeBot()
    await bot.setupOnboarded(A)
    await bot.textAs(A, '/today', {"text":"/today","route":"close_day","followUp":null})
    expect(bot.lastText(A)).toContain('Когда встретимся')
    const meeting = await prisma.outboxMessage.findFirst({ where: { kind: 'meeting', status: 'pending' } })
    expect(meeting).not.toBeNull()
  })

  it('после вопроса о встрече понимает свободный текст «начну сегодня в 11»', async () => {
    const bot = makeBot({ now: new Date('2026-09-27T06:55:00Z') })
    await bot.setupOnboarded(A, '09:55')
    await bot.textAs(A, '/today', {"text":"/today","route":"close_day","followUp":null})

    await bot.textAs(A, 'Начну сегодня в 11', {"text":"Начну сегодня в 11","route":"answer_pending","answer":{"kind":"clock","hour":11,"minute":0,"day":"today"},"followUp":null})

    const user = await prisma.user.findUniqueOrThrow({ where: { tgId: BigInt(A) } })
    expect(await prisma.outboxMessage.findFirstOrThrow({ where: { userId: user.id, kind: 'meeting', status: 'pending' } })).toMatchObject({
      sendAfter: new Date('2026-09-27T08:00:00Z'),
      payload: { defaulted: false, morning: false },
    })
    expect(await prisma.focusSession.count({ where: { userId: user.id, state: { in: ['collecting_intent', 'running', 'paused'] } } })).toBe(0)
    expect(bot.lastText(A)).toBe('Договорились: сегодня в 11:00.')
  })

  it('после вопроса о встрече voice «начну сегодня в 11» не запускает задачу', async () => {
    const transcript = 'Начну сегодня в 11'
    const model = scriptedModel()
    model.enqueue(transcript, { route: 'answer_pending', text: transcript, answer: { kind: 'clock', hour: 11, minute: 0, day: 'today' }, followUp: null })
    const bot = makeBot({
      now: new Date('2026-09-27T06:55:00Z'),
      llm: model.provider,
      stt: { enabled: true, model: 'test-stt', async transcribe() { return transcript } },
    })
    bot.tg.downloads.set('voice-meeting-time', new Uint8Array([1, 2, 3]))
    await bot.setupOnboarded(A, '09:55')
    await bot.textAs(A, '/today', {"text":"/today","route":"close_day","followUp":null})

    await bot.voice(A, { fileId: 'voice-meeting-time', duration: 6, mimeType: 'audio/ogg', fileSize: 3 })
    model.assertConsumed()
    expect(model.complete).toHaveBeenCalledTimes(1)

    const user = await prisma.user.findUniqueOrThrow({ where: { tgId: BigInt(A) } })
    expect(await prisma.outboxMessage.findFirstOrThrow({ where: { userId: user.id, kind: 'meeting', status: 'pending' } })).toMatchObject({
      sendAfter: new Date('2026-09-27T08:00:00Z'),
      payload: { defaulted: false, morning: false },
    })
    expect(await prisma.focusSession.count({ where: { userId: user.id, state: { in: ['collecting_intent', 'running', 'paused'] } } })).toBe(0)
    expect(await prisma.task.count({ where: { userId: user.id } })).toBe(0)
    expect(bot.lastText(A)).toBe('Договорились: сегодня в 11:00.')
  })

  it('voice-отчёт сохраняет результат и назначает явно названную встречу на завтра', async () => {
    const transcript = 'релиз готов завтра надо будет тестировать начинаем завтра 8:30'
    const model = scriptedModel()
    const reportText = 'релиз готов завтра надо будет тестировать'
    model.enqueue(transcript, { route: 'report', text: reportText, report: { route: 'report', progress: 'moved', next_step: 'тестировать', continue_now: false, continue_minutes: null, allocations: [] }, followUp: { route: 'schedule_meeting', text: 'начинаем завтра 8:30', hour: 8, minute: 30, day: 'tomorrow', closeDay: true } })
    const bot = makeBot({
      llm: model.provider,
      now: new Date('2026-09-27T12:20:00Z'),
      stt: { enabled: true, model: 'test-stt', async transcribe() { return transcript } },
    })
    bot.tg.downloads.set('voice-report-and-meeting', new Uint8Array([1, 2, 3]))
    await bot.setupOnboarded(A, '15:20')
    await bot.textAs(A, 'Запустить умные функции на боте', {"text":"Запустить умные функции на боте","route":"new_task","intent":{"task":null,"title":"Запустить умные функции на боте","scope":"step"},"minutes":null,"durationSource":null,"followUp":null})
    await bot.press(A, bot.lastButton(A, 'len:', ':ok'))
    const session = await prisma.focusSession.findFirstOrThrow({ where: { state: 'running' } })
    bot.advance(40)
    await runOutboxOnce(bot.ctx)
    await bot.press(A, `out:${session.id}:done`)

    await bot.voice(A, { fileId: 'voice-report-and-meeting', duration: 14, mimeType: 'audio/ogg', fileSize: 3 })
    model.assertConsumed()
    expect(model.complete).toHaveBeenCalledTimes(1)

    const user = await prisma.user.findUniqueOrThrow({ where: { tgId: BigInt(A) } })
    // The second action is only proposed; neither scheduling nor day closure
    // may happen before the user's explicit confirmation callback.
    expect(await prisma.focusSession.findUniqueOrThrow({ where: { id: session.id } })).toMatchObject({
      reportText,
      progress: 'moved',
      restChoice: null,
    })
    expect(await prisma.outboxMessage.count({ where: { userId: user.id, kind: 'meeting', status: 'pending' } })).toBe(0)
    await bot.press(A, bot.lastButton(A, 'sroute:', ':next'))
    expect(model.complete).toHaveBeenCalledTimes(1)
    expect(await prisma.focusSession.findUniqueOrThrow({ where: { id: session.id } })).toMatchObject({ reportText, progress: 'moved', restChoice: null })
    expect(await prisma.dailyGoal.findFirstOrThrow({ where: { userId: user.id } })).toMatchObject({ summarySentAt: bot.now() })
    expect(await prisma.focusSession.count({ where: { userId: user.id, state: { in: ['collecting_intent', 'running', 'paused'] } } })).toBe(0)
    expect(await prisma.outboxMessage.findFirstOrThrow({ where: { userId: user.id, kind: 'meeting', status: 'pending' } })).toMatchObject({
      sendAfter: new Date('2026-09-28T05:30:00Z'),
      payload: { defaulted: false, morning: false },
    })
    expect(await prisma.outboxMessage.count({ where: { userId: user.id, kind: 'rest_over', status: 'pending' } })).toBe(0)
    expect(bot.lastText(A)).toContain('Договорились: завтра в 08:30.')
  })

  it('обычный voice-отчёт не уходит в task-intent и сохраняет прежний вопрос про отдых', async () => {
    const transcript = 'релиз готов, завтра проверю основные сценарии'
    const model = scriptedModel()
    model.enqueue(transcript, { route: 'report', text: transcript, report: { route: 'report', progress: 'moved', next_step: 'проверю основные сценарии', continue_now: false, continue_minutes: null, allocations: [] }, followUp: null })
    const bot = makeBot({
      llm: model.provider,
      stt: { enabled: true, model: 'test-stt', async transcribe() { return transcript } },
    })
    bot.tg.downloads.set('voice-report', new Uint8Array([1, 2, 3]))
    await bot.setupOnboarded(A)
    await bot.textAs(A, 'Подготовить релиз', {"text":"Подготовить релиз","route":"new_task","intent":{"task":null,"title":"Подготовить релиз","scope":"step"},"minutes":null,"durationSource":null,"followUp":null})
    await bot.press(A, bot.lastButton(A, 'len:', ':ok'))
    const session = await prisma.focusSession.findFirstOrThrow({ where: { state: 'running' } })
    bot.advance(40)
    await runOutboxOnce(bot.ctx)
    await bot.press(A, `out:${session.id}:done`)

    await bot.voice(A, { fileId: 'voice-report', duration: 7, mimeType: 'audio/ogg', fileSize: 3 })
    model.assertConsumed()
    expect(model.complete).toHaveBeenCalledTimes(1)

    expect(await prisma.focusSession.findUniqueOrThrow({ where: { id: session.id } })).toMatchObject({
      reportText: transcript,
      progress: 'moved',
      restChoice: null,
    })
    expect(await prisma.focusSession.count({ where: { state: { in: ['collecting_intent', 'running', 'paused'] } } })).toBe(0)
    expect(bot.lastText(A)).toBe('Записал. Отдохнёшь 10 минут?')
  })

  it('число без явного «сегодня/завтра» в отчёте не превращается во встречу', async () => {
    const bot = makeBot({ now: new Date('2026-09-27T12:20:00Z') })
    await bot.setupOnboarded(A)
    await bot.textAs(A, 'Подготовить релиз', {"text":"Подготовить релиз","route":"new_task","intent":{"task":null,"title":"Подготовить релиз","scope":"step"},"minutes":null,"durationSource":null,"followUp":null})
    await bot.press(A, bot.lastButton(A, 'len:', ':ok'))
    const session = await prisma.focusSession.findFirstOrThrow({ where: { state: 'running' } })
    bot.advance(40)
    await runOutboxOnce(bot.ctx)
    await bot.press(A, `out:${session.id}:done`)

    await bot.textAs(A, 'проверил 8:30 минут лога, проблема найдена', { route: 'report', text: 'проверил 8:30 минут лога, проблема найдена', report: { route: 'report', progress: 'moved', next_step: null, continue_now: false, continue_minutes: null, allocations: [] }, followUp: null })

    expect(await prisma.focusSession.findUniqueOrThrow({ where: { id: session.id } })).toMatchObject({
      reportText: 'проверил 8:30 минут лога, проблема найдена',
      restChoice: null,
    })
    expect(await prisma.outboxMessage.count({ where: { kind: 'meeting', status: 'pending' } })).toBe(0)
    expect(bot.lastText(A)).toBe('Записал. Отдохнёшь 10 минут?')
  })

  it('свободная фраза закрывает день, останавливает таймер и показывает время по задачам', async () => {
    const phrase = 'Мозг всё, лавочка закрыта до завтра'
    const model = scriptedModel()
    model.enqueue(phrase, { route: 'close_day', text: phrase, followUp: null })
    const bot = makeBot({ llm: model.provider, stt: { enabled: true, model: 'test-stt', async transcribe() { return phrase } } })
    bot.tg.downloads.set('voice-close-day', new Uint8Array([1, 2, 3]))
    await bot.setupOnboarded(A)
    const user = await prisma.user.findUniqueOrThrow({ where: { tgId: BigInt(A) } })
    const task = await prisma.task.create({ data: { userId: user.id, title: 'Сделать презентацию' } })
    await bot.press(A, `task:${task.id}:start`)
    bot.advance(17)

    await bot.voice(A, { fileId: 'voice-close-day', duration: 4, mimeType: 'audio/ogg', fileSize: 3 })
    model.assertConsumed()
    expect(model.complete).toHaveBeenCalledTimes(1)

    expect(await prisma.focusSession.findFirstOrThrow({ where: { userId: user.id } })).toMatchObject({
      state: 'finished',
      // Исхода человек не называл — «пока не готово» не выдумываем.
      outcome: null,
      counted: true,
      restChoice: 'day_end',
      finishedAt: bot.now(),
    })
    expect(await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).toMatchObject({ status: 'active' })
    expect(bot.lastText(A)).toContain('По задачам:')
    expect(bot.lastText(A)).toContain('• Сделать презентацию — 17 минут')
    expect(await prisma.outboxMessage.count({ where: { userId: user.id, status: { in: ['pending', 'paused'] }, kind: { in: ['ping', 'session_end'] } } })).toBe(0)
  })

  it('сохраняет завершённую без таймера задачу и включает её в итог дня', async () => {
    const bot = makeBot()
    await bot.setupOnboarded(A)
    const user = await prisma.user.findUniqueOrThrow({ where: { tgId: BigInt(A) } })
    const task = await prisma.task.create({ data: { userId: user.id, title: 'Отправить документы' } })

    await bot.press(A, `task:${task.id}:done`)

    expect(await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).toMatchObject({ status: 'done' })
    expect(await prisma.task.count({ where: { id: task.id } })).toBe(1)
    expect(await prisma.event.findFirst({ where: { type: 'task_completed' } })).toMatchObject({
      payload: { task_id: task.id, source: 'button' },
    })

    await bot.textAs(A, '/today', {"text":"/today","route":"close_day","followUp":null})

    const summary = bot.textsTo(A).find((text) => text.includes('По задачам:'))
    expect(summary).toContain('• Отправить документы — выполнено без таймера')
    expect(summary).not.toContain('Отправить документы — меньше минуты')
  })

  it('делит время одной рабочей сессии между задачами без перезапуска таймера', async () => {
    const bot = makeBot()
    await bot.setupOnboarded(A)
    const user = await prisma.user.findUniqueOrThrow({ where: { tgId: BigInt(A) } })
    const first = await prisma.task.create({ data: { userId: user.id, title: 'Разобрать обратную связь' } })
    const second = await prisma.task.create({ data: { userId: user.id, title: 'Исправить макет' } })

    await bot.press(A, `task:${first.id}:start`)
    const session = await prisma.focusSession.findFirstOrThrow({ where: { userId: user.id, state: 'running' } })
    const originalEnd = session.plannedEndAt
    bot.advance(12)
    await bot.press(A, `task:${second.id}:start`)
    expect(await prisma.focusSession.findUniqueOrThrow({ where: { id: session.id } })).toMatchObject({
      state: 'running',
      taskId: second.id,
      plannedEndAt: originalEnd,
    })
    bot.advance(8)

    await bot.textAs(A, '/today', {"text":"/today","route":"close_day","followUp":null})

    const summary = bot.textsTo(A).find((text) => text.includes('По задачам:'))
    expect(summary).toContain('• Разобрать обратную связь — 12 минут')
    expect(summary).toContain('• Исправить макет — 8 минут')
  })

  it('первую задачу позднего старта считает с начала текущего рабочего периода', async () => {
    const bot = makeBot()
    await bot.setupOnboarded(A)
    const user = await prisma.user.findUniqueOrThrow({ where: { tgId: BigInt(A) } })
    const task = await prisma.task.create({ data: { userId: user.id, title: 'Подготовить презентацию' } })

    await bot.textAs(A, 'Начать сессию', {"text":"Начать сессию","route":"control","action":"focus","value":null,"followUp":null})
    const session = await prisma.focusSession.findFirstOrThrow({ where: { userId: user.id, state: 'running' } })
    expect(session.taskId).toBeNull()
    bot.advance(12)
    await bot.press(A, `task:${task.id}:start`)
    bot.advance(8)
    await bot.textAs(A, '/today', {"text":"/today","route":"close_day","followUp":null})

    const summary = bot.textsTo(A).find((text) => text.includes('По задачам:'))
    expect(summary).toContain('• Подготовить презентацию — 20 минут')
  })

  it('позднее назначение после отдыха не захватывает предыдущий рабочий период', async () => {
    const bot = makeBot()
    await bot.setupOnboarded(A)
    const user = await prisma.user.findUniqueOrThrow({ where: { tgId: BigInt(A) } })
    const task = await prisma.task.create({ data: { userId: user.id, title: 'Разобрать документы' } })

    await bot.textAs(A, 'Начать сессию', {"text":"Начать сессию","route":"control","action":"focus","value":null,"followUp":null})
    bot.advance(10)
    await bot.textAs(A, 'Перерыв', {"text":"Перерыв","route":"break","minutes":null,"durationSource":null,"followUp":null})
    bot.advance(15)
    await bot.textAs(A, 'Вернуться к работе', {"text":"Вернуться к работе","route":"continue_same","minutes":null,"durationSource":null,"followUp":null})
    bot.advance(12)
    await bot.press(A, `task:${task.id}:start`)
    bot.advance(8)
    await bot.textAs(A, '/today', {"text":"/today","route":"close_day","followUp":null})

    const summary = bot.textsTo(A).find((text) => text.includes('По задачам:'))
    expect(summary).toContain('• Разобрать документы — 20 минут')
    expect(summary).not.toContain('30 минут')
  })

  it('принимает постфактум распределение времени между задачами с остатком', async () => {
    const bot = makeBot()
    await bot.setupOnboarded(A)
    const user = await prisma.user.findUniqueOrThrow({ where: { tgId: BigInt(A) } })
    await prisma.task.create({ data: { userId: user.id, title: 'Подготовить презентацию' } })
    await prisma.task.create({ data: { userId: user.id, title: 'Ответить на письма' } })
    await prisma.task.create({ data: { userId: user.id, title: 'Собрать отчёт' } })

    await bot.textAs(A, 'Начать сессию', {"text":"Начать сессию","route":"control","action":"focus","value":null,"followUp":null})
    const session = await prisma.focusSession.findFirstOrThrow({ where: { userId: user.id, state: 'running' } })
    bot.advance(40)
    await runOutboxOnce(bot.ctx)
    await bot.press(A, `out:${session.id}:done`)
    const labelledTasks = await prisma.task.findMany({ where: { userId: user.id, status: { in: ['active', 'done'] } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
    const labelFor = (title: string) => {
      const index = labelledTasks.findIndex((task) => task.title === title)
      expect(index).toBeGreaterThanOrEqual(0)
      return `t${index + 1}`
    }
    const reportText = 'Закончил. 15 минут на презентацию, 5 минут на письма, остальное на отчёт'
    await bot.textAs(A, reportText, { route: 'report', text: reportText, report: {
      route: 'report', progress: 'moved', next_step: null, continue_now: false, continue_minutes: null,
      allocations: [
        { task: labelFor('Подготовить презентацию'), title: 'Подготовить презентацию', minutes: 15, remainder: false, source: '15 минут на презентацию' },
        { task: labelFor('Ответить на письма'), title: 'Ответить на письма', minutes: 5, remainder: false, source: '5 минут на письма' },
        { task: labelFor('Собрать отчёт'), title: 'Собрать отчёт', minutes: null, remainder: true, source: 'остальное на отчёт' },
      ],
    }, followUp: null })
    expect(bot.textsTo(A).some((text) => text.includes('Распределил 40 минут'))).toBe(true)
    expect(await prisma.taskTimeAllocation.findMany({
      where: { sessionId: session.id },
      orderBy: { seconds: 'asc' },
      select: { seconds: true },
    })).toEqual([{ seconds: 300 }, { seconds: 900 }, { seconds: 1200 }])
    expect(await prisma.focusSession.findUniqueOrThrow({ where: { id: session.id } })).toMatchObject({ counted: true })
    expect(await prisma.pointsEntry.aggregate({ where: { refKey: `session:${session.id}` }, _sum: { amount: true } })).toMatchObject({
      _sum: { amount: 10 },
    })

    await bot.textAs(A, '/today', {"text":"/today","route":"close_day","followUp":null})
    const summary = bot.textsTo(A).find((text) => text.includes('По задачам:'))
    expect(summary).toContain('• Подготовить презентацию — 15 минут')
    expect(summary).toContain('• Ответить на письма — 5 минут')
    expect(summary).toContain('• Собрать отчёт — 20 минут')
  })

  it('не применяет постфактум-разметку больше фактического времени', async () => {
    const bot = makeBot()
    await bot.setupOnboarded(A)
    const user = await prisma.user.findUniqueOrThrow({ where: { tgId: BigInt(A) } })
    await prisma.task.create({ data: { userId: user.id, title: 'Подготовить презентацию' } })

    await bot.textAs(A, 'Начать сессию', {"text":"Начать сессию","route":"control","action":"focus","value":null,"followUp":null})
    const session = await prisma.focusSession.findFirstOrThrow({ where: { userId: user.id, state: 'running' } })
    bot.advance(40)
    await runOutboxOnce(bot.ctx)
    await bot.press(A, `out:${session.id}:done`)
    await bot.textAs(A, '50 минут на презентацию', { route: 'report', text: '50 минут на презентацию', report: { route: 'report', progress: 'moved', next_step: null, continue_now: false, continue_minutes: null, allocations: [{ task: 't1', title: 'Подготовить презентацию', minutes: 50, remainder: false, source: '50 минут на презентацию' }] }, followUp: null })

    expect(bot.textsTo(A)).toContain('Не смог надёжно распределить время: указанные минуты превышают фактическую работу. Сам отчёт сохранил без изменений.')
    expect(await prisma.taskTimeAllocation.count({ where: { sessionId: session.id } })).toBe(0)
    expect(await prisma.focusSession.findUniqueOrThrow({ where: { id: session.id } })).toMatchObject({ counted: true })
  })

  it('суммирует рабочие периоды одной сессии и не относит отдых ко времени задачи', async () => {
    const bot = makeBot()
    await bot.setupOnboarded(A)
    const user = await prisma.user.findUniqueOrThrow({ where: { tgId: BigInt(A) } })
    const task = await prisma.task.create({ data: { userId: user.id, title: 'Подготовить релиз' } })

    await bot.press(A, `task:${task.id}:start`)
    bot.advance(10)
    await bot.textAs(A, 'Перерыв', {"text":"Перерыв","route":"break","minutes":null,"durationSource":null,"followUp":null})
    bot.advance(20)
    await bot.textAs(A, 'Вернуться к работе', {"text":"Вернуться к работе","route":"continue_same","minutes":null,"durationSource":null,"followUp":null})
    bot.advance(15)
    await bot.textAs(A, '/today', {"text":"/today","route":"close_day","followUp":null})

    const summary = bot.textsTo(A).find((text) => text.includes('По задачам:'))
    expect(summary).toContain('• Подготовить релиз — 25 минут')
    expect(summary).not.toContain('45 минут')
  })

  it('подтверждение времени встречи не отменяет такую же встречу по умолчанию', async () => {
    const bot = makeBot({ now: new Date('2026-09-24T16:51:00Z') })
    await bot.setupOnboarded(A, '19:51')
    const user = await prisma.user.findUniqueOrThrow({ where: { tgId: BigInt(A) } })
    await prisma.user.update({ where: { id: user.id }, data: { morningTime: '08:30' } })

    await bot.textAs(A, '/today', {"text":"/today","route":"close_day","followUp":null})
    const before = await prisma.outboxMessage.findFirstOrThrow({ where: { userId: user.id, kind: 'meeting' } })
    expect(before).toMatchObject({ status: 'pending', payload: { defaulted: true, morning: true } })

    await bot.press(A, 'meet::morning')

    const meetings = await prisma.outboxMessage.findMany({ where: { userId: user.id, kind: 'meeting' } })
    expect(meetings).toHaveLength(1)
    expect(meetings[0]).toMatchObject({ status: 'pending', payload: { defaulted: false, morning: true } })
    expect(meetings[0]?.sendAfter).toEqual(before.sendAfter)
  })

  it('выбор другого времени отменяет прежнюю встречу и оставляет одну активную', async () => {
    const bot = makeBot({ now: new Date('2026-09-24T16:51:00Z') })
    await bot.setupOnboarded(A, '19:51')
    const user = await prisma.user.findUniqueOrThrow({ where: { tgId: BigInt(A) } })
    await prisma.user.update({ where: { id: user.id }, data: { morningTime: '08:30' } })

    await bot.textAs(A, '/today', {"text":"/today","route":"close_day","followUp":null})
    await bot.press(A, 'meet::custom')
    await bot.textAs(A, '09:00', {"text":"09:00","route":"answer_pending","answer":{"kind":"clock","hour":9,"minute":0,"day":"next"},"followUp":null})

    const meetings = await prisma.outboxMessage.findMany({ where: { userId: user.id, kind: 'meeting' }, orderBy: { sendAfter: 'asc' } })
    expect(meetings.map((m) => m.status)).toEqual(['canceled', 'pending'])
    expect(meetings[1]?.payload).toEqual({ defaulted: false, morning: false })
  })

  it('отключение пингов отменяет уже запланированную проверку', async () => {
    const bot = makeBot()
    await bot.setupOnboarded(A)
    await bot.textAs(A, 'набросать план главы', {"text":"набросать план главы","route":"new_task","intent":{"task":null,"title":"набросать план главы","scope":"step"},"minutes":null,"durationSource":null,"followUp":null})
    await bot.press(A, bot.lastButton(A, 'len:', ':ok'))

    const user = await prisma.user.findUniqueOrThrow({ where: { tgId: BigInt(A) } })
    const session = await prisma.focusSession.findFirstOrThrow({ where: { userId: user.id, state: 'running' } })
    expect(await prisma.outboxMessage.findFirstOrThrow({ where: { idempotencyKey: `ping:${session.id}:1` } })).toMatchObject({
      status: 'pending',
    })

    await bot.textAs(A, '/settings', {"text":"/settings","route":"control","action":"settings","value":null,"followUp":null})
    await bot.press(A, bot.lastButton(A, 'set:', ':pings'))

    expect(await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).toMatchObject({ pingsEnabled: false })
    expect(await prisma.outboxMessage.findFirstOrThrow({ where: { idempotencyKey: `ping:${session.id}:1` } })).toMatchObject({
      status: 'canceled',
    })

    bot.advance(20)
    await runOutboxOnce(bot.ctx)
    expect(bot.textsTo(A)).not.toContain('На месте?')
  })

  it('трижды досидел и сразу продолжал — бот один раз предлагает длинные блоки', async () => {
    const bot = makeBot()
    await bot.setupOnboarded(A)
    const user = await prisma.user.findUniqueOrThrow({ where: { tgId: BigInt(A) } })
    for (let i = 0; i < 4; i++) {
      await bot.textAs(A, `шаг ${i}`, work(`шаг ${i}`, `шаг ${i}`))
      await bot.press(A, bot.lastButton(A, 'len:', ':ok'))
      const s = await prisma.focusSession.findFirstOrThrow({ where: { userId: user.id, state: 'running' } })
      bot.advance(40)
      await bot.press(A, `out:${s.id}:done`)
      await bot.press(A, `skiprep:${s.id}:`)
      await bot.press(A, `rest:${s.id}:continue`)
    }
    const suggestions = bot.textsTo(A).filter((t) => t.includes('длинные блоки'))
    expect(suggestions).toHaveLength(1)
    // И предложение длины выросло по правилу «трижды просил ещё».
    expect(bot.textsTo(A).filter((t) => t.startsWith('Давай')).at(-1)).toBe('Давай 50 минут работы, потом 10 отдыха.')
  })
})
