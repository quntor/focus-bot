import { beforeEach, describe, expect, it } from 'vitest'
import { runOutboxOnce } from '../outbox/worker.js'
import { makeBot } from '../test/bot.js'
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
      ['Мои задачи'],
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

  it('быстрый старт наследует работу из последней сессии, но не требует ответа', async () => {
    const bot = makeBot()
    await bot.onboard(A)
    await bot.text(A, 'набросать план главы, 25 минут')
    const previous = await prisma.focusSession.findFirstOrThrow({ where: { state: 'running' } })
    await bot.text(A, '/stop')

    await bot.text(A, 'Начать сессию')

    const running = await prisma.focusSession.findFirstOrThrow({ where: { state: 'running' } })
    expect(running.id).not.toBe(previous.id)
    expect(running).toMatchObject({
      intentText: 'набросать план главы, 25 минут',
      taskId: previous.taskId,
      plannedMinutes: 40,
      minutesSource: 'bot',
    })
    expect(bot.textsTo(A).some((text) => text.includes('«набросать план главы, 25 минут»'))).toBe(true)
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
    expect(await prisma.task.findUniqueOrThrow({ where: { id: started.taskId! } })).toMatchObject({ sessionsCount: 1 })
    expect(await prisma.task.findUniqueOrThrow({ where: { id: renamed.taskId! } })).toMatchObject({ sessionsCount: 1 })

    bot.advance(10)
    await bot.press(A, bot.lastButton(A, 'run:', ':duration'))
    await bot.text(A, '5 минут')
    expect(bot.lastText(A)).toContain('Уже прошло 10 минут')
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

  it('замораживает таймер и возвращает в ту же сессию с оставшимся временем', async () => {
    const bot = makeBot()
    await bot.onboard(A)
    await bot.text(A, 'допишу раздел за 40 минут')
    const running = await prisma.focusSession.findFirstOrThrow({ where: { state: 'running' } })
    const originalEnd = running.plannedEndAt!

    bot.advance(10)
    await bot.text(A, 'Перерыв')

    const paused = await prisma.focusSession.findUniqueOrThrow({ where: { id: running.id } })
    expect(paused.state).toBe('paused')
    expect((paused as { pausedAt?: Date | null }).pausedAt).toEqual(bot.now())
    expect((bot.tg.sent.at(-1) as { replyKeyboard?: string[][] } | undefined)?.replyKeyboard).toEqual([
      ['Вернуться к работе', 'Начать новую сессию'],
      ['Мои задачи'],
    ])
    expect(await prisma.outboxMessage.findFirstOrThrow({ where: { idempotencyKey: `session_end:${running.id}` } })).toMatchObject({
      status: 'paused',
    })

    bot.advance(35)
    await runOutboxOnce(bot.ctx)
    expect(bot.textsTo(A)).not.toContain('Время! Как прошло?')

    await bot.text(A, 'Вернуться к работе')
    const resumed = await prisma.focusSession.findUniqueOrThrow({ where: { id: running.id } })
    expect(resumed.state).toBe('running')
    expect(resumed.plannedEndAt).toEqual(new Date(originalEnd.getTime() + 35 * MIN))
    expect((resumed as { pausedAt?: Date | null }).pausedAt).toBeNull()
    expect((resumed as { pausedSeconds?: number }).pausedSeconds).toBe((35 * MIN) / 1000)
    expect(await prisma.outboxMessage.findFirstOrThrow({ where: { idempotencyKey: `session_end:${running.id}` } })).toMatchObject({
      status: 'pending',
      sendAfter: resumed.plannedEndAt,
    })
    expect((bot.tg.sent.at(-1) as { replyKeyboard?: string[][] } | undefined)?.replyKeyboard).toEqual([
      ['Начать сессию', 'Перерыв'],
      ['Мои задачи'],
    ])

    bot.advance(30)
    await runOutboxOnce(bot.ctx)
    expect(bot.textsTo(A)).toContain('Время! Как прошло?')
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

    const abandoned = await prisma.focusSession.findUniqueOrThrow({ where: { id: old.id } })
    expect(abandoned).toMatchObject({ state: 'abandoned', abandonReason: 'new_session' })
    expect((abandoned as { pausedSeconds?: number }).pausedSeconds).toBe((25 * MIN) / 1000)
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
    expect(next).toMatchObject({ intentText: old.intentText, taskId: old.taskId, plannedMinutes: 40 })
    expect(bot.lastText(A)).toContain('Таймер уже идёт')

    const stopped = await prisma.event.findFirstOrThrow({ where: { sessionId: old.id, type: 'session_stopped' } })
    expect(stopped.payload).toMatchObject({ session_id: old.id, elapsed_minutes: 10 })
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
})
