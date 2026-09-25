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
    ])
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
        where: { userId: old.userId, kind: { in: ['ping', 'session_end'] }, status: { in: ['pending', 'paused'] } },
      }),
    ).toEqual([])
    expect(await prisma.focusSession.findFirstOrThrow({ where: { userId: old.userId, state: 'collecting_intent' } })).not.toBeNull()
    expect(bot.lastText(A)).toContain('С чего начнёшь?')

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
