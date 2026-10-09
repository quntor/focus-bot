import { beforeEach, describe, expect, it } from 'vitest'
import { sweepOnce } from '../jobs/sweeper.js'
import { runOutboxOnce } from '../outbox/worker.js'
import { makeBot } from '../test/bot.js'
import { T } from './texts.js'
import { hasDb, prisma, resetDb } from '../test/db.js'

const A = 1085
const MIN = 60_000

describe.skipIf(!hasDb)('постоянные кнопки и перерыв', () => {
  beforeEach(resetDb)

  it('показывает постоянные основные действия после знакомства', async () => {
    const bot = makeBot()
    await bot.setupOnboarded(A)

    expect((bot.tg.sent.at(-1) as { replyKeyboard?: string[][] } | undefined)?.replyKeyboard).toEqual([
      ['Начать сессию', 'Перерыв'],
      ['Мои задачи', 'Статус'],
    ])
  })

  it('по кнопке сразу начинает сессию и позволяет немедленно уйти на перерыв', async () => {
    const bot = makeBot()
    await bot.setupOnboarded(A)

    await bot.textAs(A, 'Начать сессию', {"text":"Начать сессию","route":"control","action":"focus","value":null,"followUp":null})

    const running = await prisma.focusSession.findFirstOrThrow({ where: { state: 'running' } })
    expect(running).toMatchObject({ intentText: null, plannedMinutes: 40, minutesSource: 'bot' })
    expect(running.startedAt).toEqual(bot.now())
    expect(bot.lastText(A)).toContain('40 минут')
    expect(bot.lastButton(A, 'run:', ':work')).toBe(`run:${running.id}:work`)
    expect(bot.lastButton(A, 'run:', ':duration')).toBe(`run:${running.id}:duration`)

    await bot.textAs(A, 'Перерыв', {"text":"Перерыв","route":"break","minutes":null,"durationSource":null,"followUp":null})
    expect(await prisma.focusSession.findUniqueOrThrow({ where: { id: running.id } })).toMatchObject({ state: 'paused' })
  })

  it('постоянные кнопки безопасно работаю из любого состояния', async () => {
    const bot = makeBot()
    await bot.setupOnboarded(A)

    await bot.textAs(A, 'Перерыв', {"text":"Перерыв","route":"break","minutes":null,"durationSource":null,"followUp":null})
    expect(bot.lastText(A)).toContain('Отдыхай')

    await bot.textAs(A, 'Начать новую сессию', {"text":"Начать новую сессию","route":"control","action":"new_session","value":null,"followUp":null})
    const first = await prisma.focusSession.findFirstOrThrow({ where: { state: 'running' } })

    bot.advance(5)
    await bot.textAs(A, 'Начать новую сессию', {"text":"Начать новую сессию","route":"control","action":"new_session","value":null,"followUp":null})
    // Прошлая засчитывается по отработанному; 5 минут — меньше порога.
    expect(await prisma.focusSession.findUniqueOrThrow({ where: { id: first.id } })).toMatchObject({
      state: 'finished',
      outcome: null,
      counted: false,
    })
    const second = await prisma.focusSession.findFirstOrThrow({ where: { state: 'running' } })
    expect(second.id).not.toBe(first.id)
    expect(second.startedAt).toEqual(bot.now())
  })

  it('быстрый старт не наследует прошлую работу и не требует ответа', async () => {
    const bot = makeBot()
    await bot.setupOnboarded(A)
    await bot.textAs(A, 'набросать план главы, 25 минут', {"text":"набросать план главы, 25 минут","route":"new_task","intent":{"task":null,"title":"набросать план главы","scope":"step"},"minutes":25,"durationSource":"25 минут","followUp":null})
    const previous = await prisma.focusSession.findFirstOrThrow({ where: { state: 'running' } })
    await bot.textAs(A, '/stop', {"text":"/stop","route":"control","action":"stop","value":null,"followUp":null})

    await bot.textAs(A, 'Начать сессию', {"text":"Начать сессию","route":"control","action":"focus","value":null,"followUp":null})

    const running = await prisma.focusSession.findFirstOrThrow({ where: { state: 'running' } })
    expect(running.id).not.toBe(previous.id)
    expect(running).toMatchObject({
      intentText: null,
      taskId: null,
      plannedMinutes: 40,
      minutesSource: 'bot',
    })
    expect(bot.textsTo(A).some((text) => text.includes('40 минут'))).toBe(true)
  })

  it('после старта меняет работу и общую длительность без перезапуска сессии', async () => {
    const bot = makeBot()
    await bot.setupOnboarded(A)
    await bot.textAs(A, 'набросать план главы, 25 минут', {"text":"набросать план главы, 25 минут","route":"new_task","intent":{"task":null,"title":"набросать план главы","scope":"step"},"minutes":25,"durationSource":"25 минут","followUp":null})
    await bot.textAs(A, '/stop', {"text":"/stop","route":"control","action":"stop","value":null,"followUp":null})
    await bot.textAs(A, 'Начать сессию', {"text":"Начать сессию","route":"control","action":"focus","value":null,"followUp":null})
    const started = await prisma.focusSession.findFirstOrThrow({ where: { state: 'running' } })

    await bot.press(A, bot.lastButton(A, 'run:', ':work'))
    await bot.textAs(A, 'написать введение', {"text":"написать введение","route":"new_task","intent":{"task":null,"title":"написать введение","scope":"step"},"minutes":null,"durationSource":null,"followUp":null})
    const renamed = await prisma.focusSession.findUniqueOrThrow({ where: { id: started.id } })
    expect(renamed).toMatchObject({ state: 'running', intentText: 'написать введение' })
    expect(renamed.startedAt).toEqual(started.startedAt)
    expect(renamed.plannedEndAt).toEqual(started.plannedEndAt)
    expect(renamed.taskId).not.toBe(started.taskId)
    expect(await prisma.task.findUniqueOrThrow({ where: { id: renamed.taskId! } })).toMatchObject({ sessionsCount: 1 })
    expect(await prisma.event.findFirstOrThrow({ where: { sessionId: started.id, type: 'intent_parsed' }, orderBy: { id: 'desc' } })).toMatchObject({
      payload: expect.objectContaining({ from_period_start: true }),
    })

    bot.advance(10)
    await bot.press(A, bot.lastButton(A, 'run:', ':duration'))
    await bot.textAs(A, '5 минут', {route:'clarify',text:'5 минут',question:'Уже прошло 10 минут. Выбери больший срок.',followUp:null})
    expect(bot.lastText(A)).toContain('прошло 10 минут')
    expect(await prisma.focusSession.findUniqueOrThrow({ where: { id: started.id } })).toMatchObject({ plannedMinutes: 40 })

    await bot.textAs(A, '50 минут', {"text":"50 минут","route":"answer_pending","answer":{"kind":"duration","minutes":50},"followUp":null})
    const resized = await prisma.focusSession.findUniqueOrThrow({ where: { id: started.id } })
    expect(resized).toMatchObject({ state: 'running', plannedMinutes: 50, minutesSource: 'user' })
    expect(resized.startedAt).toEqual(started.startedAt)
    expect(resized.plannedEndAt).toEqual(new Date(started.startedAt!.getTime() + 50 * MIN))
    expect(await prisma.outboxMessage.findFirstOrThrow({ where: { idempotencyKey: `session_end:${started.id}` } })).toMatchObject({
      status: 'pending',
      sendAfter: resized.plannedEndAt,
    })
    expect(await prisma.outboxMessage.findFirstOrThrow({ where: { idempotencyKey: `ping:${started.id}:1` } })).toMatchObject({
      status: 'pending',
      sendAfter: new Date(started.startedAt!.getTime() + 25 * MIN),
    })
    expect(bot.lastText(A)).toContain('50 минут')
  })

  it('после отдыха запускает в той же сессии новый полный период работы', async () => {
    const bot = makeBot()
    await bot.setupOnboarded(A)
    await bot.textAs(A, 'допишу раздел за 40 минут', {"text":"допишу раздел за 40 минут","route":"new_task","intent":{"task":null,"title":"допишу раздел","scope":"step"},"minutes":40,"durationSource":"40 минут","followUp":null})
    const running = await prisma.focusSession.findFirstOrThrow({ where: { state: 'running' } })
    bot.advance(10)
    await bot.textAs(A, 'Перерыв', {"text":"Перерыв","route":"break","minutes":null,"durationSource":null,"followUp":null})

    const paused = await prisma.focusSession.findUniqueOrThrow({ where: { id: running.id } })
    expect(paused.state).toBe('paused')
    expect((paused as { pausedAt?: Date | null }).pausedAt).toEqual(bot.now())
    expect((bot.tg.sent.at(-1) as { replyKeyboard?: string[][] } | undefined)?.replyKeyboard).toEqual([
      ['Вернуться к работе', 'Начать новую сессию'],
      ['Мои задачи', 'Статус'],
    ])
    expect(await prisma.outboxMessage.findFirstOrThrow({ where: { idempotencyKey: `session_end:${running.id}` } })).toMatchObject({ status: 'canceled' })

    bot.advance(35)
    await runOutboxOnce(bot.ctx)
    expect(bot.textsTo(A)).not.toContain('Время вышло: поработай ещё или пора отдыхать?')

    await bot.textAs(A, 'Вернуться к работе', {"text":"Вернуться к работе","route":"continue_same","minutes":null,"durationSource":null,"followUp":null})
    const resumed = await prisma.focusSession.findUniqueOrThrow({ where: { id: running.id } })
    expect(resumed.state).toBe('running')
    expect(resumed.plannedEndAt).toEqual(new Date(bot.now().getTime() + 40 * MIN))
    expect((resumed as { pausedAt?: Date | null }).pausedAt).toBeNull()
    expect((resumed as { pausedSeconds?: number }).pausedSeconds).toBe((35 * MIN) / 1000)
    expect(await prisma.outboxMessage.findFirstOrThrow({
      where: { idempotencyKey: { startsWith: `session_end:${running.id}:` }, status: 'pending' },
    })).toMatchObject({
      status: 'pending',
      sendAfter: resumed.plannedEndAt,
    })
    expect(bot.lastText(A)).toContain('Новый период работы — 40 минут')
    expect((bot.tg.sent.at(-1) as { replyKeyboard?: string[][] } | undefined)?.replyKeyboard).toEqual([
      ['Начать сессию', 'Перерыв'],
      ['Мои задачи', 'Статус'],
    ])

    bot.advance(39)
    await runOutboxOnce(bot.ctx)
    expect(bot.lastText(A)).not.toBe('Время вышло: поработай ещё или пора отдыхать?')
    bot.advance(1)
    await runOutboxOnce(bot.ctx)
    expect(bot.textsTo(A)).toContain('Время вышло: поработай ещё или пора отдыхать?')
  })

  it('после завершившегося периода принимает перерыв и запускает новый полный период', async () => {
    const bot = makeBot()
    await bot.setupOnboarded(A)
    await bot.textAs(A, 'допишу раздел за 30 минут', {"text":"допишу раздел за 30 минут","route":"new_task","intent":{"task":null,"title":"допишу раздел","scope":"step"},"minutes":30,"durationSource":"30 минут","followUp":null})
    const running = await prisma.focusSession.findFirstOrThrow({ where: { state: 'running' } })

    bot.advance(30)
    await runOutboxOnce(bot.ctx)
    expect(bot.lastText(A)).toBe('Время вышло: поработай ещё или пора отдыхать?')

    await bot.textAs(A, 'Перерыв', {"text":"Перерыв","route":"break","minutes":null,"durationSource":null,"followUp":null})

    expect(await prisma.focusSession.findUniqueOrThrow({ where: { id: running.id } })).toMatchObject({
      state: 'paused',
      pausedSeconds: 0,
    })
    expect(bot.lastText(A)).toContain('Ты на перерыве')

    bot.advance(7)
    await bot.textAs(A, 'Вернуться к работе', {"text":"Вернуться к работе","route":"continue_same","minutes":null,"durationSource":null,"followUp":null})
    expect(await prisma.focusSession.findUniqueOrThrow({ where: { id: running.id } })).toMatchObject({
      state: 'running',
      plannedEndAt: new Date(bot.now().getTime() + 30 * MIN),
      pausedSeconds: (7 * MIN) / 1000,
    })
    expect(bot.lastText(A)).toContain('Новый период работы — 30 минут')
  })

  it('возврат из старой просроченной паузы тоже запускает полный новый период', async () => {
    const bot = makeBot()
    await bot.setupOnboarded(A)
    await bot.textAs(A, 'допишу раздел за 30 минут', {"text":"допишу раздел за 30 минут","route":"new_task","intent":{"task":null,"title":"допишу раздел","scope":"step"},"minutes":30,"durationSource":"30 минут","followUp":null})
    const running = await prisma.focusSession.findFirstOrThrow({ where: { state: 'running' } })
    bot.advance(36)
    await prisma.focusSession.update({
      where: { id: running.id },
      data: { state: 'paused', pausedAt: bot.now() },
    })
    await prisma.outboxMessage.updateMany({
      where: {
        userId: running.userId,
        status: 'pending',
        OR: [{ idempotencyKey: { startsWith: `ping:${running.id}` } }, { idempotencyKey: `session_end:${running.id}` }],
      },
      data: { status: 'paused' },
    })
    bot.advance(17)

    await bot.textAs(A, 'Вернуться к работе', {"text":"Вернуться к работе","route":"continue_same","minutes":null,"durationSource":null,"followUp":null})

    expect(await prisma.focusSession.findUniqueOrThrow({ where: { id: running.id } })).toMatchObject({
      state: 'running',
      plannedEndAt: new Date(bot.now().getTime() + 30 * MIN),
      pausedAt: null,
      pausedSeconds: (17 * MIN) / 1000,
    })
    expect(
      await prisma.outboxMessage.count({
        where: {
          userId: running.userId,
          status: 'pending',
          idempotencyKey: { startsWith: `session_end:${running.id}:` },
        },
      }),
    ).toBe(1)
    expect(bot.lastText(A)).toContain('Новый период работы — 30 минут')
  })

  it('после возврата меняет длительность только текущего нового периода', async () => {
    const bot = makeBot()
    await bot.setupOnboarded(A)
    await bot.textAs(A, 'допишу раздел за 40 минут', {"text":"допишу раздел за 40 минут","route":"new_task","intent":{"task":null,"title":"допишу раздел","scope":"step"},"minutes":40,"durationSource":"40 минут","followUp":null})
    const running = await prisma.focusSession.findFirstOrThrow({ where: { state: 'running' } })

    bot.advance(10)
    await bot.textAs(A, 'Перерыв', {"text":"Перерыв","route":"break","minutes":null,"durationSource":null,"followUp":null})
    bot.advance(5)
    await bot.textAs(A, 'Вернуться к работе', {"text":"Вернуться к работе","route":"continue_same","minutes":null,"durationSource":null,"followUp":null})
    await bot.press(A, `run:${running.id}:duration`)
    await bot.textAs(A, '50 минут', {"text":"50 минут","route":"answer_pending","answer":{"kind":"duration","minutes":50},"followUp":null})

    const resized = await prisma.focusSession.findUniqueOrThrow({ where: { id: running.id } })
    expect(resized).toMatchObject({ state: 'running', plannedMinutes: 50 })
    expect(resized.plannedEndAt).toEqual(new Date(bot.now().getTime() + 50 * MIN))
    expect(await prisma.outboxMessage.count({
      where: { userId: running.userId, kind: 'session_end', status: 'pending' },
    })).toBe(1)
    expect(await prisma.outboxMessage.findFirstOrThrow({
      where: { userId: running.userId, kind: 'session_end', status: 'pending' },
    })).toMatchObject({ sendAfter: resized.plannedEndAt })
  })

  it('на перерыве закрывает прежнюю сессию и только затем начинает новую', async () => {
    const bot = makeBot()
    await bot.setupOnboarded(A)
    await bot.textAs(A, 'допишу раздел за 40 минут', {"text":"допишу раздел за 40 минут","route":"new_task","intent":{"task":null,"title":"допишу раздел","scope":"step"},"minutes":40,"durationSource":"40 минут","followUp":null})
    const old = await prisma.focusSession.findFirstOrThrow({ where: { state: 'running' } })

    bot.advance(10)
    await bot.textAs(A, 'Перерыв', {"text":"Перерыв","route":"break","minutes":null,"durationSource":null,"followUp":null})
    bot.advance(25)
    await bot.textAs(A, 'Начать новую сессию', {"text":"Начать новую сессию","route":"control","action":"new_session","value":null,"followUp":null})

    const closed = await prisma.focusSession.findUniqueOrThrow({ where: { id: old.id } })
    expect(closed).toMatchObject({ state: 'finished', counted: true })
    expect(closed.pausedSeconds).toBe((25 * MIN) / 1000)
    expect(
      await prisma.outboxMessage.findMany({
        where: {
          userId: old.userId,
          status: { in: ['pending', 'paused'] },
          OR: [{ idempotencyKey: { startsWith: `ping:${old.id}` } }, { idempotencyKey: `session_end:${old.id}` }],
        },
      }),
    ).toEqual([])
    const next = await prisma.focusSession.findFirstOrThrow({ where: { userId: old.userId, state: 'running' } })
    expect(next).toMatchObject({ intentText: null, taskId: null, plannedMinutes: 40 })
    expect(bot.lastText(A)).toContain('Сессия началась')

    const finished = await prisma.event.findFirstOrThrow({ where: { sessionId: old.id, type: 'session_auto_finished' } })
    expect(finished.payload).toMatchObject({ session_id: old.id, elapsed_minutes: 10, counted: true, reason: 'new_session' })
  })

  it('не возвращает отложенный пинг, если его отключили во время перерыва', async () => {
    const bot = makeBot()
    await bot.setupOnboarded(A)
    await bot.textAs(A, 'набросать план главы', {"text":"набросать план главы","route":"new_task","intent":{"task":null,"title":"набросать план главы","scope":"step"},"minutes":null,"durationSource":null,"followUp":null})
    await bot.press(A, bot.lastButton(A, 'len:', ':ok'))
    const session = await prisma.focusSession.findFirstOrThrow({ where: { state: 'running' } })

    bot.advance(10)
    await bot.textAs(A, 'Перерыв', {"text":"Перерыв","route":"break","minutes":null,"durationSource":null,"followUp":null})
    await bot.textAs(A, '/settings', {"text":"/settings","route":"control","action":"settings","value":null,"followUp":null})
    await bot.press(A, bot.lastButton(A, 'set:', ':pings'))
    await bot.textAs(A, 'Вернуться к работе', {"text":"Вернуться к работе","route":"continue_same","minutes":null,"durationSource":null,"followUp":null})

    expect(await prisma.focusSession.findUniqueOrThrow({ where: { id: session.id } })).toMatchObject({ state: 'running', pingAt: null })
    expect(await prisma.outboxMessage.findMany({ where: { userId: session.userId, kind: 'ping', status: 'pending' } })).toEqual([])
  })

  it('по истечении отдыха зовёт обратно, а после возврата — молчит', async () => {
    const bot = makeBot()
    await bot.setupOnboarded(A)
    await bot.textAs(A, 'Начать сессию', {"text":"Начать сессию","route":"control","action":"focus","value":null,"followUp":null})
    bot.advance(15)
    await bot.textAs(A, 'Перерыв', {"text":"Перерыв","route":"break","minutes":null,"durationSource":null,"followUp":null})
    expect(bot.lastText(A)).toContain('напишу в')

    bot.advance(10)
    await runOutboxOnce(bot.ctx)
    expect(bot.lastText(A)).toBe(T.breakOver)

    await bot.textAs(A, 'Вернуться к работе', {"text":"Вернуться к работе","route":"continue_same","minutes":null,"durationSource":null,"followUp":null})
    bot.advance(5)
    await bot.textAs(A, 'Перерыв', {"text":"Перерыв","route":"break","minutes":null,"durationSource":null,"followUp":null})
    await bot.textAs(A, 'Вернуться к работе', {"text":"Вернуться к работе","route":"continue_same","minutes":null,"durationSource":null,"followUp":null})
    bot.advance(10)
    await runOutboxOnce(bot.ctx)
    expect(bot.textsTo(A).filter((text) => text === T.breakOver)).toHaveLength(1)
  })

  it('забытый перерыв закрывает сессию через 3 часа, и бот не замолкает', async () => {
    const bot = makeBot()
    await bot.setupOnboarded(A)
    await bot.textAs(A, 'Начать сессию', {"text":"Начать сессию","route":"control","action":"focus","value":null,"followUp":null})
    const session = await prisma.focusSession.findFirstOrThrow({ where: { state: 'running' } })
    bot.advance(15)
    await bot.textAs(A, 'Перерыв', {"text":"Перерыв","route":"break","minutes":null,"durationSource":null,"followUp":null})

    bot.advance(3 * 60 + 1)
    await sweepOnce(bot.ctx)

    expect(await prisma.focusSession.findUniqueOrThrow({ where: { id: session.id } })).toMatchObject({ state: 'finished', outcome: null, counted: true })
    expect(bot.lastText(A)).toContain('Перерыв затянулся')
    expect(bot.lastText(A)).toContain('15 минут')
    expect(await prisma.outboxMessage.count({ where: { userId: session.userId, kind: 'meeting', status: 'pending' } })).toBe(1)

    const before = bot.tg.sent.length
    for (let h = 0; h < 48; h++) {
      bot.advance(60)
      await runOutboxOnce(bot.ctx)
      await sweepOnce(bot.ctx)
    }
    expect(bot.tg.sent.slice(before).filter((m) => m.text.includes('Готов начать?')).length).toBeGreaterThanOrEqual(2)
  })

  it('вечерняя сводка на перерыве не пишет «сессий не было»', async () => {
    const bot = makeBot({ now: new Date('2026-09-22T17:30:00Z') }) // 20:30 МСК
    await bot.setupOnboarded(A, '20:30')
    await bot.textAs(A, 'Начать сессию', {"text":"Начать сессию","route":"control","action":"focus","value":null,"followUp":null})
    bot.advance(20)
    await bot.textAs(A, 'Перерыв', {"text":"Перерыв","route":"break","minutes":null,"durationSource":null,"followUp":null})
    bot.advance(10) // 21:00 — согласованное время сводки
    // Сводка не перебивает незаконченный вопрос об исходе.
    const user = await prisma.user.findUniqueOrThrow({ where: { tgId: BigInt(A) } })
    await prisma.user.update({ where: { id: user.id }, data: { pendingInput: 'none' } })

    await runOutboxOnce(bot.ctx)

    const summary = bot.textsTo(A).find((text) => text.includes('Серия:'))
    expect(summary).toContain('Сессия на перерыве — итог посчитаю, когда закончишь.')
    expect(summary).not.toContain('сессий не было')
  })
})
