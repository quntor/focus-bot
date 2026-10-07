import { beforeEach, describe, expect, it } from 'vitest'
import { hasDb, prisma, resetDb } from '../test/db.js'
import { makeBot } from '../test/bot.js'
import { enqueue } from './queue.js'
import { recoverStuck, runOutboxOnce } from './worker.js'
import { recentConversationContext } from '../bot/conversation-context.js'
import { DeliveryError, TelegramError } from '../tg/client.js'

const A = 4001

async function runningSession(bot: ReturnType<typeof makeBot>) {
  await bot.setupOnboarded(A)
  await bot.textAs(A, 'глава, 40 минут', {"text":"глава, 40 минут","route":"new_task","intent":{"task":null,"title":"глава","scope":"step"},"minutes":40,"durationSource":"40 минут","followUp":null})
  return prisma.focusSession.findFirstOrThrow({ where: { state: 'running' } })
}

describe.skipIf(!hasDb)('outbox', () => {
  beforeEach(resetDb)

  it('утром показывает активные задачи и запускает выбранную одним нажатием', async () => {
    const bot = makeBot()
    await bot.setupOnboarded(A)
    const user = await prisma.user.findUniqueOrThrow({ where: { tgId: BigInt(A) } })
    await prisma.user.update({ where: { id: user.id }, data: { pendingInput: 'meeting_time' } })
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
    expect(prompt?.text).toBe(
      ['Доброе утро! Пора работать.', '', 'У тебя такие дела:', `1. ${first.title}`, `2. ${second.title}`, '', 'С чего начнёшь?'].join('\n'),
    )
    expect(prompt?.keyboard?.slice(0, 2)).toEqual([
      [{ text: first.title, data: `task:${first.id}:start` }],
      [{ text: second.title, data: `task:${second.id}:start` }],
    ])
    expect(prompt?.keyboard?.slice(-2)).toEqual([
      [{ text: '▶️ Просто начать', data: 'quick::start' }],
      [{ text: 'План на день', data: 'quick::goal' }],
    ])
    expect(bot.buttons(A).filter((button) => button.data.includes(':view'))).toHaveLength(0)
    expect(await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).toMatchObject({ pendingInput: 'none' })

    await bot.press(A, `task:${second.id}:start`)

    const running = await prisma.focusSession.findFirstOrThrow({ where: { userId: user.id, state: 'running' } })
    expect(running).toMatchObject({ taskId: second.id, intentText: second.title, plannedMinutes: 40 })
    expect(running.startedAt).not.toBeNull()
    expect(running.plannedEndAt).not.toBeNull()
    expect(await prisma.outboxMessage.count({ where: { userId: user.id, kind: 'session_end', status: 'pending' } })).toBe(1)
  })

  it('утренняя цель остаётся необязательным действием после списка задач', async () => {
    const bot = makeBot()
    await bot.setupOnboarded(A)
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
    expect(bot.lastText(A)).toContain('Сделать план дня')
    await bot.press(A, 'quick::goal')
    expect(bot.lastText(A)).toBe('Сколько заходов сегодня?')
    await bot.press(A, 'goal::3')

    const prompt = bot.tg.sent.filter((message) => message.chatId === BigInt(A)).at(-1)
    expect(prompt?.text).toBe(
      ['Цель на сегодня — 3 захода.', '', 'У тебя такие дела:', `1. ${task.title}`, '', 'С чего начнёшь?'].join('\n'),
    )
    expect(prompt?.keyboard?.[0]).toEqual([{ text: task.title, data: `task:${task.id}:start` }])
  })

  it('утром без задач позволяет одним нажатием начать период без задачи', async () => {
    const bot = makeBot()
    await bot.setupOnboarded(A)
    const user = await prisma.user.findUniqueOrThrow({ where: { tgId: BigInt(A) } })
    await enqueue(prisma, {
      userId: user.id,
      kind: 'meeting',
      key: `meeting:${user.id}:morning-empty`,
      sendAfter: bot.now(),
      payload: { defaulted: false, morning: true },
    })

    await runOutboxOnce(bot.ctx)

    expect(bot.lastText(A)).toBe('Доброе утро! Пора работать. Можно начать без задачи или написать, что будешь делать.')
    expect(bot.lastButton(A, 'quick:', ':start')).toBe('quick::start')
    await bot.press(A, 'quick::start')
    expect(await prisma.focusSession.findFirstOrThrow({ where: { userId: user.id, state: 'running' } })).toMatchObject({
      taskId: null,
      intentText: null,
      plannedMinutes: 40,
    })
  })

  it('после полудня по местному времени здоровается без «доброго утра»', async () => {
    const bot = makeBot()
    await bot.setupOnboarded(A)
    const user = await prisma.user.findUniqueOrThrow({ where: { tgId: BigInt(A) } })
    bot.advance(5 * 60) // 15:00 по Москве
    await enqueue(prisma, {
      userId: user.id,
      kind: 'meeting',
      key: `meeting:${user.id}:afternoon`,
      sendAfter: bot.now(),
      payload: { defaulted: false, morning: true },
    })

    await runOutboxOnce(bot.ctx)

    expect(bot.lastText(A)).toBe('Привет! Пора работать. Можно начать без задачи или написать, что будешь делать.')
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

    expect(await prisma.user.findUniqueOrThrow({ where: { id: session.userId } })).toMatchObject({ pendingInput: `session_end:${session.id}` })
    expect(bot.lastText(A)).toBe('Время вышло: поработай ещё или пора отдыхать?')
    expect(bot.lastButton(A, 'end:', ':continue')).toBe(`end:${session.id}:continue`)
    expect(bot.lastButton(A, 'end:', ':break')).toBe(`end:${session.id}:break`)
    expect(recentConversationContext(session.userId, bot.now()).at(-1)).toEqual({
      role: 'assistant',
      text: 'Время вышло: поработай ещё или пора отдыхать?',
    })
  })

  it('после дедлайна: «Ещё поработаю» сдвигает конец, «Пора отдыхать» спрашивает исход', async () => {
    const continuingBot = makeBot()
    const continuing = await runningSession(continuingBot)
    continuingBot.advance(40)
    await runOutboxOnce(continuingBot.ctx)

    expect(await prisma.focusSession.findUniqueOrThrow({ where: { id: continuing.id } })).toMatchObject({ state: 'running' })
    await continuingBot.press(A, `end:${continuing.id}:continue`)
    const extended = await prisma.focusSession.findUniqueOrThrow({ where: { id: continuing.id } })
    expect(extended).toMatchObject({ state: 'running' })
    expect(extended.plannedEndAt).toEqual(new Date(continuingBot.now().getTime() + 15 * 60_000))
    expect(await prisma.outboxMessage.count({ where: { kind: 'session_end', status: 'pending' } })).toBe(1)
    expect(continuingBot.lastText(A)).toContain('ещё 15 минут')
    expect(await prisma.user.findUniqueOrThrow({ where: { id: continuing.userId } })).toMatchObject({ pendingInput: 'none' })

    await resetDb()
    const breakBot = makeBot()
    const pausing = await runningSession(breakBot)
    breakBot.advance(40)
    await runOutboxOnce(breakBot.ctx)
    await breakBot.press(A, `end:${pausing.id}:break`)
    expect(breakBot.lastText(A)).toContain('Перерыв начался: 10 минут.')
    await breakBot.press(A, `out:${pausing.id}:done`)
    expect(await prisma.focusSession.findUniqueOrThrow({ where: { id: pausing.id } })).toMatchObject({ state: 'finished', counted: true })
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
    expect(bot.tg.sent.filter((s) => s.text === 'Время вышло: поработай ещё или пора отдыхать?')).toHaveLength(1)
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
