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
    await bot.onboard(A)

    expect((bot.tg.sent.at(-1) as { replyKeyboard?: string[][] } | undefined)?.replyKeyboard).toEqual([
      ['Начать сессию', 'Перерыв'],
      ['Мои задачи', 'Статус'],
    ])
  })

  it('по кнопке сразу начинает сессию и позволяет немедленно уйти на перерыв', async () => {
    const bot = makeBot()
    await bot.onboard(A)

    await bot.text(A, 'Начать сессию')

    const running = await prisma.focusSession.findFirstOrThrow({ where: { state: 'running' } })
    expect(running).toMatchObject({ intentText: null, plannedMinutes: 40, minutesSource: 'bot' })
    expect(running.startedAt).toEqual(bot.now())
    expect(bot.lastText(A)).toContain('40 минут')
    expect(bot.lastButton(A, 'run:', ':work')).toBe(`run:${running.id}:work`)
    expect(bot.lastButton(A, 'run:', ':duration')).toBe(`run:${running.id}:duration`)

    await bot.text(A, 'Перерыв')
    expect(await prisma.focusSession.findUniqueOrThrow({ where: { id: running.id } })).toMatchObject({ state: 'paused' })
  })

  it('постоянные кнопки безопасно работаю из любого состояния', async () => {
    const bot = makeBot()
    await bot.onboard(A)

    await bot.text(A, 'Перерыв')
    expect(bot.lastText(A)).toContain('Отдыхай')

    await bot.text(A, 'Начать новую сессию')
    const first = await prisma.focusSession.findFirstOrThrow({ where: { state: 'running' } })

    bot.advance(5)
    await bot.text(A, 'Начать новую сессию')
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
    await bot.onboard(A)
    await bot.text(A, 'набросать план главы, 25 минут')
    const previous = await prisma.focusSession.findFirstOrThrow({ where: { state: 'running' } })
    await bot.text(A, '/stop')

    await bot.text(A, 'Начать сессию')

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
    await bot.onboard(A)
    await bot.text(A, 'набросать план главы, 25 минут')
    await bot.text(A, '/stop')
    await bot.text(A, 'Начать сессию')
    const started = await prisma.focusSession.findFirstOrThrow({ where: { state: 'running' } })

    await bot.press(A, bot.lastButton(A, 'run:', ':work'))
    await bot.text(A, 'написать введение')
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
    await bot.text(A, '5 минут')
    expect(bot.lastText(A)).toContain('уже прошло 10 минут')
    expect(await prisma.focusSession.findUniqueOrThrow({ where: { id: started.id } })).toMatchObject({ plannedMinutes: 40 })

    await bot.text(A, '50 минут')
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
    await bot.onboard(A)
    await bot.text(A, 'допишу раздел за 40 минут')
    const running = await prisma.focusSession.findFirstOrThrow({ where: { state: 'running' } })
    bot.advance(10)
    await bot.text(A, 'Перерыв')

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

    await bot.text(A, 'Вернуться к работе')
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
    await bot.onboard(A)
    await bot.text(A, 'допишу раздел за 30 минут')
    const running = await prisma.focusSession.findFirstOrThrow({ where: { state: 'running' } })

    bot.advance(30)
    await runOutboxOnce(bot.ctx)
    expect(bot.lastText(A)).toBe('Время вышло: поработай ещё или пора отдыхать?')

    await bot.text(A, 'Перерыв')

    expect(await prisma.focusSession.findUniqueOrThrow({ where: { id: running.id } })).toMatchObject({
      state: 'paused',
      pausedSeconds: 0,
    })
    expect(bot.lastText(A)).toContain('Ты на перерыве')

    bot.advance(7)
    await bot.text(A, 'Вернуться к работе')
    expect(await prisma.focusSession.findUniqueOrThrow({ where: { id: running.id } })).toMatchObject({
      state: 'running',
      plannedEndAt: new Date(bot.now().getTime() + 30 * MIN),
      pausedSeconds: (7 * MIN) / 1000,
    })
    expect(bot.lastText(A)).toContain('Новый период работы — 30 минут')
  })

  it('возврат из старой просроченной паузы тоже запускает полный новый период', async () => {
    const bot = makeBot()
    await bot.onboard(A)
    await bot.text(A, 'допишу раздел за 30 минут')
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

    await bot.text(A, 'Вернуться к работе')

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
    await bot.onboard(A)
    await bot.text(A, 'допишу раздел за 40 минут')
    const running = await prisma.focusSession.findFirstOrThrow({ where: { state: 'running' } })

    bot.advance(10)
    await bot.text(A, 'Перерыв')
    bot.advance(5)
    await bot.text(A, 'Вернуться к работе')
    await bot.press(A, `run:${running.id}:duration`)
    await bot.text(A, '50 минут')

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
    await bot.onboard(A)
    await bot.text(A, 'допишу раздел за 40 минут')
    const old = await prisma.focusSession.findFirstOrThrow({ where: { state: 'running' } })

    bot.advance(10)
    await bot.text(A, 'Перерыв')
    bot.advance(25)
    await bot.text(A, 'Начать новую сессию')

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
    expect(bot.lastText(A)).toContain('Таймер уже идёт')

    const finished = await prisma.event.findFirstOrThrow({ where: { sessionId: old.id, type: 'session_auto_finished' } })
    expect(finished.payload).toMatchObject({ session_id: old.id, elapsed_minutes: 10, counted: true, reason: 'new_session' })
  })

  it('не возвращает отложенный пинг, если его отключили во время перерыва', async () => {
    const bot = makeBot()
    await bot.onboard(A)
    await bot.text(A, 'набросать план главы')
    await bot.press(A, bot.lastButton(A, 'len:', ':ok'))
    const session = await prisma.focusSession.findFirstOrThrow({ where: { state: 'running' } })

    bot.advance(10)
    await bot.text(A, 'Перерыв')
    await bot.text(A, '/settings')
    await bot.press(A, bot.lastButton(A, 'set:', ':pings'))
    await bot.text(A, 'Вернуться к работе')

    expect(await prisma.focusSession.findUniqueOrThrow({ where: { id: session.id } })).toMatchObject({ state: 'running', pingAt: null })
    expect(await prisma.outboxMessage.findMany({ where: { userId: session.userId, kind: 'ping', status: 'pending' } })).toEqual([])
  })

  it('по истечении отдыха зовёт обратно, а после возврата — молчит', async () => {
    const bot = makeBot()
    await bot.onboard(A)
    await bot.text(A, 'Начать сессию')
    bot.advance(15)
    await bot.text(A, 'Перерыв')
    expect(bot.lastText(A)).toContain('напишу в')

    bot.advance(10)
    await runOutboxOnce(bot.ctx)
    expect(bot.lastText(A)).toBe(T.breakOver)

    await bot.text(A, 'Вернуться к работе')
    bot.advance(5)
    await bot.text(A, 'Перерыв')
    await bot.text(A, 'Вернуться к работе')
    bot.advance(10)
    await runOutboxOnce(bot.ctx)
    expect(bot.textsTo(A).filter((text) => text === T.breakOver)).toHaveLength(1)
  })

  it('забытый перерыв закрывает сессию через 3 часа, и бот не замолкает', async () => {
    const bot = makeBot()
    await bot.onboard(A)
    await bot.text(A, 'Начать сессию')
    const session = await prisma.focusSession.findFirstOrThrow({ where: { state: 'running' } })
    bot.advance(15)
    await bot.text(A, 'Перерыв')

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
    expect(bot.tg.sent.slice(before).filter((m) => m.text.includes('Пора работать')).length).toBeGreaterThanOrEqual(2)
  })

  it('вечерняя сводка на перерыве не пишет «сессий не было»', async () => {
    const bot = makeBot({ now: new Date('2026-09-22T17:30:00Z') }) // 20:30 МСК
    await bot.onboard(A, '20:30')
    await bot.text(A, 'Начать сессию')
    bot.advance(20)
    await bot.text(A, 'Перерыв')
    bot.advance(15)

    await runOutboxOnce(bot.ctx)

    const summary = bot.textsTo(A).find((text) => text.includes('Серия:'))
    expect(summary).toContain('Сессия на перерыве — итог посчитаю, когда закончишь.')
    expect(summary).not.toContain('сессий не было')
  })
})
