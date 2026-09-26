import { beforeEach, describe, expect, it } from 'vitest'
import { hasDb, prisma, resetDb } from '../test/db.js'
import { makeBot } from '../test/bot.js'
import { enqueue } from './queue.js'
import { recoverStuck, runOutboxOnce } from './worker.js'
import { DeliveryError, TelegramError } from '../tg/client.js'

const A = 4001

async function runningSession(bot: ReturnType<typeof makeBot>) {
  await bot.onboard(A)
  await bot.text(A, 'глава, 40 минут')
  return prisma.focusSession.findFirstOrThrow({ where: { state: 'running' } })
}

describe.skipIf(!hasDb)('outbox', () => {
  beforeEach(resetDb)

  it('утром показывает активные задачи и запускает выбранную одним нажатием', async () => {
    const bot = makeBot()
    await bot.onboard(A)
    const user = await prisma.user.findUniqueOrThrow({ where: { tgId: BigInt(A) } })
    await prisma.dailyGoal.create({ data: { userId: user.id, dayKey: '2026-09-22', targetSessions: 3 } })
    const first = await prisma.task.create({ data: { userId: user.id, title: 'Подготовить отчёт' } })
    const second = await prisma.task.create({ data: { userId: user.id, title: 'Позвонить Ивану' } })
    await enqueue(prisma, {
      userId: user.id,
      kind: 'meeting',
      key: `meeting:${user.id}:morning-with-tasks`,
      sendAfter: bot.now(),
      payload: { defaulted: false, morning: true },
    })

    await runOutboxOnce(bot.ctx)

    const prompt = bot.tg.sent.filter((message) => message.chatId === BigInt(A)).at(-1)
    expect(prompt?.text).toContain('Привет! С чего начнёшь?')
    expect(prompt?.keyboard?.slice(0, 2)).toEqual([
      [{ text: first.title, data: `task:${first.id}:start` }],
      [{ text: second.title, data: `task:${second.id}:start` }],
    ])
    expect(bot.buttons(A).filter((button) => button.data.includes(':view'))).toHaveLength(0)

    await bot.press(A, `task:${second.id}:start`)

    const running = await prisma.focusSession.findFirstOrThrow({ where: { userId: user.id, state: 'running' } })
    expect(running).toMatchObject({ taskId: second.id, intentText: second.title, plannedMinutes: 40 })
    expect(running.startedAt).not.toBeNull()
    expect(running.plannedEndAt).not.toBeNull()
    expect(await prisma.outboxMessage.count({ where: { userId: user.id, kind: 'session_end', status: 'pending' } })).toBe(1)
  })

  it('после выбора утренней цели показывает задачи с прямым запуском', async () => {
    const bot = makeBot()
    await bot.onboard(A)
    const user = await prisma.user.findUniqueOrThrow({ where: { tgId: BigInt(A) } })
    const task = await prisma.task.create({ data: { userId: user.id, title: 'Сделать план дня' } })
    await enqueue(prisma, {
      userId: user.id,
      kind: 'meeting',
      key: `meeting:${user.id}:morning-goal`,
      sendAfter: bot.now(),
      payload: { defaulted: false, morning: true },
    })

    await runOutboxOnce(bot.ctx)
    expect(bot.lastText(A)).toBe('Доброе утро. Сколько заходов сегодня?')
    await bot.press(A, 'goal::3')

    const prompt = bot.tg.sent.filter((message) => message.chatId === BigInt(A)).at(-1)
    expect(prompt?.text).toContain('Цель на сегодня — 3 захода.')
    expect(prompt?.text).toContain('С чего начнёшь?')
    expect(prompt?.keyboard).toEqual([[{ text: task.title, data: `task:${task.id}:start` }]])
  })

  it('утром без задач сохраняет обычный вопрос и кнопки напоминания', async () => {
    const bot = makeBot()
    await bot.onboard(A)
    const user = await prisma.user.findUniqueOrThrow({ where: { tgId: BigInt(A) } })
    await prisma.dailyGoal.create({ data: { userId: user.id, dayKey: '2026-09-22', targetSessions: 1 } })
    await enqueue(prisma, {
      userId: user.id,
      kind: 'meeting',
      key: `meeting:${user.id}:morning-empty`,
      sendAfter: bot.now(),
      payload: { defaulted: false, morning: true },
    })

    await runOutboxOnce(bot.ctx)

    expect(bot.lastText(A)).toBe('Привет! С чего начнёшь?')
    expect(bot.lastButton(A, 'mtg:', ':postpone')).toBe('mtg::postpone')
  })

  it('два воркера одновременно не отправляют одно сообщение дважды', async () => {
    const bot = makeBot()
    await runningSession(bot)
    bot.advance(20)
    const before = bot.tg.sent.length
    await Promise.all([runOutboxOnce(bot.ctx), runOutboxOnce(bot.ctx), runOutboxOnce(bot.ctx)])
    expect(bot.tg.sent.slice(before).filter((s) => s.text === 'На месте?')).toHaveLength(1)
    await runOutboxOnce(bot.ctx)
    expect(bot.tg.sent.slice(before).filter((s) => s.text === 'На месте?')).toHaveLength(1)
  })

  it('не отправляет пинг, если настройка выключена перед доставкой', async () => {
    const bot = makeBot()
    const session = await runningSession(bot)
    await prisma.user.update({ where: { id: session.userId }, data: { pingsEnabled: false } })

    bot.advance(20)
    const before = bot.tg.sent.length
    await runOutboxOnce(bot.ctx)

    expect(bot.tg.sent.slice(before).filter((s) => s.text === 'На месте?')).toHaveLength(0)
    expect((await prisma.outboxMessage.findFirstOrThrow({ where: { kind: 'ping' } })).status).toBe('skipped')
  })

  it('повторная постановка с тем же ключом не создаёт второго сообщения', async () => {
    const bot = makeBot()
    const s = await runningSession(bot)
    const at = new Date(bot.now().getTime() + 60_000)
    await enqueue(prisma, { userId: s.userId, kind: 'ping', key: `ping:${s.id}:1`, sendAfter: at, payload: { sessionId: s.id, n: 1 } })
    expect(await prisma.outboxMessage.count({ where: { idempotencyKey: `ping:${s.id}:1` } })).toBe(1)
  })

  it('окончание сессии сбрасывает незавершённую правку работы', async () => {
    const bot = makeBot()
    const session = await runningSession(bot)
    await bot.press(A, bot.lastButton(A, 'run:', ':work'))
    expect(await prisma.user.findUniqueOrThrow({ where: { id: session.userId } })).toMatchObject({
      pendingInput: `running_work:${session.id}`,
    })

    bot.advance(40)
    await runOutboxOnce(bot.ctx)

    expect(await prisma.user.findUniqueOrThrow({ where: { id: session.userId } })).toMatchObject({ pendingInput: 'none' })
  })

  it('упавший посреди отправки процесс: сообщение не переотправляется, а помечается uncertain', async () => {
    const bot = makeBot()
    await runningSession(bot)
    bot.advance(20)
    // Имитация: строку взяли в работу и умерли — статус sending, аренда истекла.
    await prisma.outboxMessage.updateMany({
      where: { kind: 'ping' },
      data: { status: 'sending', lockedUntil: new Date(bot.now().getTime() - 1000) },
    })
    const before = bot.tg.sent.length
    await recoverStuck(bot.ctx)
    await runOutboxOnce(bot.ctx)
    expect(bot.tg.sent.slice(before).filter((s) => s.text === 'На месте?')).toHaveLength(0)
    expect((await prisma.outboxMessage.findFirstOrThrow({ where: { kind: 'ping' } })).status).toBe('uncertain')
    expect(await prisma.event.count({ where: { type: 'outbox_uncertain' } })).toBe(1)
  })

  it('ответа нет после отправки — uncertain; соединение не установилось — повтор', async () => {
    const bot = makeBot()
    await runningSession(bot)
    bot.advance(20)
    bot.tg.failNext.push(new DeliveryError(true, 'UND_ERR_SOCKET'))
    await runOutboxOnce(bot.ctx)
    expect((await prisma.outboxMessage.findFirstOrThrow({ where: { kind: 'ping' } })).status).toBe('uncertain')

    bot.advance(20)
    bot.tg.failNext.push(new DeliveryError(false, 'ECONNREFUSED'))
    await runOutboxOnce(bot.ctx)
    const end = await prisma.outboxMessage.findFirstOrThrow({ where: { kind: 'session_end' } })
    expect(end.status).toBe('pending')
    bot.advance(1)
    await runOutboxOnce(bot.ctx)
    expect((await prisma.outboxMessage.findFirstOrThrow({ where: { kind: 'session_end' } })).status).toBe('sent')
    expect(bot.tg.sent.filter((s) => s.text === 'Время! Как прошло?')).toHaveLength(1)
  })

  it('403 — пользователь помечен blockedAt, очередь гасится, ретраев нет', async () => {
    const bot = makeBot()
    const s = await runningSession(bot)
    bot.advance(20)
    bot.tg.failNext.push(new TelegramError('blocked', 403))
    await runOutboxOnce(bot.ctx)
    const user = await prisma.user.findUniqueOrThrow({ where: { id: s.userId } })
    expect(user.blockedAt).not.toBeNull()
    expect(await prisma.outboxMessage.count({ where: { userId: s.userId, status: 'pending' } })).toBe(0)
    bot.advance(30)
    const before = bot.tg.sent.length
    await runOutboxOnce(bot.ctx)
    expect(bot.tg.sent.length).toBe(before)
  })

  it('перезапуск не теряет отложенное: сообщение лежит в базе, а не в таймере', async () => {
    const bot = makeBot()
    await runningSession(bot)
    // «Новый процесс» — новый контекст с тем же временем и базой.
    const fresh = makeBot({ now: new Date(bot.now().getTime() + 20 * 60_000) })
    await runOutboxOnce(fresh.ctx)
    expect(fresh.tg.sent.map((s) => s.text)).toContain('На месте?')
  })
})
