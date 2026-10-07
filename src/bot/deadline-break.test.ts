import { beforeEach, describe, expect, it } from 'vitest'
import { hasDb, prisma, resetDb } from '../test/db.js'
import { makeBot } from '../test/bot.js'
import { runOutboxOnce } from '../outbox/worker.js'

const A = 27001

async function beginBreak() {
  const bot = makeBot()
  await bot.setupOnboarded(A)
  await bot.textAs(A, 'отчёт, 40 минут', {"text":"отчёт, 40 минут","route":"new_task","intent":{"task":null,"title":"отчёт","scope":"step"},"minutes":40,"durationSource":"40 минут","followUp":null})
  const session = await prisma.focusSession.findFirstOrThrow({ where: { state: 'running' } })
  bot.advance(40)
  await runOutboxOnce(bot.ctx)
  await bot.press(A, `end:${session.id}:break`)
  return { bot, session, at: bot.now() }
}

describe.skipIf(!hasDb)('перерыв после дедлайна не зависит от отчёта', () => {
  beforeEach(resetDb)

  it('сразу останавливает работу и зовёт обратно даже без исхода', async () => {
    const { bot, session, at } = await beginBreak()
    expect(await prisma.focusSession.findUniqueOrThrow({ where: { id: session.id } })).toMatchObject({ state: 'paused', pausedAt: at })
    expect(bot.lastText(A)).toContain('Перерыв начался')
    expect(bot.lastText(A)).toContain('10 минут')
    expect(bot.lastText(A)).toContain('10:50')
    await bot.press(A, `end:${session.id}:break`)
    expect(await prisma.outboxMessage.count({ where: { userId: session.userId, kind: 'break_over', status: 'pending' } })).toBe(1)
    bot.advance(10)
    await runOutboxOnce(bot.ctx)
    expect(bot.lastText(A)).toContain('Перерыв закончился')
  })

  it.each(['silent', 'skip', 'text'] as const)('исход и отчёт (%s) не откладывают конец отдыха', async (report) => {
    const { bot, session, at } = await beginBreak()
    bot.advance(3)
    await bot.press(A, `out:${session.id}:done`)
    const finished = await prisma.focusSession.findUniqueOrThrow({ where: { id: session.id } })
    expect(finished).toMatchObject({ state: 'finished', restChoice: 'rest', pausedSeconds: 180 })
    expect(await prisma.event.findFirstOrThrow({ where: { sessionId: session.id, type: 'session_completed' } })).toMatchObject({ payload: { elapsed_minutes: 40 } })
    const reminder = await prisma.outboxMessage.findFirstOrThrow({ where: { userId: session.userId, kind: 'break_over', status: 'pending' } })
    expect(reminder.sendAfter).toEqual(new Date(at.getTime() + 10 * 60_000))
    if (report === 'skip') await bot.press(A, `skiprep:${session.id}`)
    if (report === 'text') await bot.text(A, 'отчёт готов')
    expect(await prisma.outboxMessage.count({ where: { userId: session.userId, kind: { in: ['rest_over', 'break_over'] }, status: 'pending' } })).toBe(1)
    bot.advance(7)
    await runOutboxOnce(bot.ctx)
    expect(bot.lastText(A)).toBe('Отдых закончился. С чего продолжишь?')
    const sent = bot.textsTo(A).filter((text) => /(?:Отдых|Перерыв) закончился/.test(text))
    expect(sent).toHaveLength(1)
  })

  it('поздний исход не запускает ещё один отдых после отправленного напоминания', async () => {
    const { bot, session } = await beginBreak()
    bot.advance(10)
    await runOutboxOnce(bot.ctx)
    await bot.press(A, `out:${session.id}:done`)
    await bot.press(A, `skiprep:${session.id}`)
    bot.advance(10)
    await runOutboxOnce(bot.ctx)
    expect(bot.textsTo(A).filter((text) => /(?:Отдых|Перерыв) закончился/.test(text))).toHaveLength(1)
  })

  it('возврат к работе отменяет применимость старого напоминания', async () => {
    const { bot, session } = await beginBreak()
    bot.advance(2)
    await bot.textAs(A, 'Вернуться к работе', {"text":"Вернуться к работе","route":"continue_same","minutes":null,"durationSource":null,"followUp":null})
    expect(await prisma.focusSession.findUniqueOrThrow({ where: { id: session.id } })).toMatchObject({ state: 'running', pausedSeconds: 120 })
    bot.advance(8)
    await runOutboxOnce(bot.ctx)
    expect(bot.textsTo(A).filter((text) => /(?:Отдых|Перерыв) закончился/.test(text))).toHaveLength(0)
  })

  it('новая работа после исхода не получает напоминание старого отдыха', async () => {
    const { bot, session } = await beginBreak()
    await bot.press(A, `out:${session.id}:done`)
    await bot.textAs(A, 'Начать новую сессию', {"text":"Начать новую сессию","route":"control","action":"new_session","value":null,"followUp":null})
    expect(await prisma.focusSession.count({ where: { userId: session.userId, state: 'running' } })).toBe(1)
    bot.advance(10)
    await runOutboxOnce(bot.ctx)
    expect(bot.textsTo(A).filter((text) => /(?:Отдых|Перерыв) закончился/.test(text))).toHaveLength(0)
  })

  it('после перезапуска доставляет сохранённый таймер без ответа на отчёт', async () => {
    const { bot, session, at } = await beginBreak()
    await bot.press(A, `out:${session.id}:other`)
    const restarted = makeBot({ now: new Date(at.getTime() + 10 * 60_000) })
    await runOutboxOnce(restarted.ctx)
    expect(restarted.lastText(A)).toBe('Отдых закончился. С чего продолжишь?')
  })

  it('старый перерыв не воскресает после нового перерыва и исхода', async () => {
    const { bot, session } = await beginBreak()
    bot.advance(2)
    await bot.textAs(A, 'Вернуться к работе', {"text":"Вернуться к работе","route":"continue_same","minutes":null,"durationSource":null,"followUp":null})
    bot.advance(2)
    await bot.textAs(A, 'Перерыв', {"text":"Перерыв","route":"break","minutes":null,"durationSource":null,"followUp":null})
    await bot.press(A, `out:${session.id}:not_done`)
    bot.advance(6)
    await runOutboxOnce(bot.ctx)
    expect(bot.textsTo(A).filter((text) => /(?:Отдых|Перерыв) закончился/.test(text))).toHaveLength(0)
    bot.advance(4)
    await runOutboxOnce(bot.ctx)
    expect(bot.textsTo(A).filter((text) => /(?:Отдых|Перерыв) закончился/.test(text))).toHaveLength(1)
  })
})
