import { beforeEach, describe, expect, it } from 'vitest'
import { workDayKey } from '../lib/day.js'
import type { LlmProvider } from '../llm/provider.js'
import { runOutboxOnce } from '../outbox/worker.js'
import { makeBot } from '../test/bot.js'
import { hasDb, prisma, resetDb } from '../test/db.js'
import { buildSummary } from './day-flow.js'

// Сессию заканчивают таймер, /done, «Пора отдыхать», «иду отдыхать» и /stop.
// Бросает только /stop; остальное засчитывается по отработанному времени.
// Сценарии — из аудита логики 01.10.
const A = 5301

const user = () => prisma.user.findUniqueOrThrow({ where: { tgId: BigInt(A) } })

describe.skipIf(!hasDb)('конец сессии', () => {
  beforeEach(resetDb)

  it('«✅ Завершить» у текущей задачи после 20 минут не обрывает таймер', async () => {
    const bot = makeBot()
    await bot.onboard(A)
    const u = await user()
    const task = await prisma.task.create({ data: { userId: u.id, title: 'Слайды' } })
    await bot.press(A, `task:${task.id}:start`)
    bot.advance(20)

    await bot.press(A, `task:${task.id}:done`)

    expect(await prisma.focusSession.findFirstOrThrow({ where: { userId: u.id } })).toMatchObject({ state: 'running', taskId: null })
    expect(bot.lastText(A)).toContain('Таймер идёт дальше')
  })

  it('«готово, иду отдыхать» в сессии без задачи закрывает сессию и даёт отдых', async () => {
    const llm: LlmProvider = {
      enabled: true,
      model: 'test-model',
      async complete(req) {
        if (req.system.includes('помощник внутри активной фокус-сессии')) {
          return { text: '{"kind":"complete_and_rest","reply":null,"action":null,"task_title":null}', usage: null }
        }
        throw new Error('unexpected LLM call')
      },
    }
    const bot = makeBot({ llm })
    await bot.onboard(A)
    await bot.text(A, 'Начать сессию')
    bot.advance(25)

    await bot.text(A, 'готово, иду отдыхать')

    const s = await prisma.focusSession.findFirstOrThrow({ where: { userId: (await user()).id } })
    expect(s).toMatchObject({ state: 'finished', counted: true, restChoice: 'rest' })
    expect(bot.lastText(A)).toContain('Отдыхай')
    expect(bot.lastText(A)).not.toContain('неактуально')
  })

  it('«не закончил, пойду отдыхать» — перерыв, задача остаётся открытой', async () => {
    const bot = makeBot()
    await bot.onboard(A)
    await bot.text(A, '/focus Написать отчёт по продажам')
    await bot.press(A, bot.lastButton(A, 'len:', ':ok'))
    bot.advance(20)

    await bot.text(A, 'не закончил, пойду отдыхать')

    expect(await prisma.task.findMany({ select: { status: true } })).toEqual([{ status: 'active' }])
    expect(await prisma.focusSession.findFirstOrThrow()).toMatchObject({ state: 'paused', outcome: null })
  })

  it('«сделал и иду отдыхать» закрывает текущую задачу, а не заводит задачу «и»', async () => {
    const bot = makeBot()
    await bot.onboard(A)
    await bot.text(A, '/focus Написать отчёт по продажам')
    await bot.press(A, bot.lastButton(A, 'len:', ':ok'))
    bot.advance(20)

    await bot.text(A, 'сделал и иду отдыхать')

    expect(await prisma.task.findMany({ select: { title: true, status: true } })).toEqual([{ title: 'Написать отчёт по продажам', status: 'done' }])
    expect(await prisma.focusSession.findFirstOrThrow()).toMatchObject({ state: 'finished', outcome: 'done' })
  })

  it('«закончил отчёт и иду отдыхать» узнаёт задачу своими словами', async () => {
    const bot = makeBot()
    await bot.onboard(A)
    await bot.text(A, '/focus Написать отчёт по продажам')
    await bot.press(A, bot.lastButton(A, 'len:', ':ok'))
    bot.advance(20)

    await bot.text(A, 'закончил отчёт и иду отдыхать')

    expect(await prisma.task.findMany({ select: { title: true, status: true } })).toEqual([{ title: 'Написать отчёт по продажам', status: 'done' }])
  })

  it('закрытая посреди сессии задача перестаёт копить время', async () => {
    const bot = makeBot()
    await bot.onboard(A)
    const u = await user()
    const first = await prisma.task.create({ data: { userId: u.id, title: 'Написать отчёт', createdAt: bot.now() } })
    const second = await prisma.task.create({ data: { userId: u.id, title: 'Слайды для клиента', createdAt: bot.now() } })
    await bot.press(A, `task:${first.id}:start`)
    bot.advance(20)
    await bot.press(A, `task:${first.id}:done`)
    bot.advance(10)
    await bot.press(A, `task:${second.id}:start`)
    bot.advance(10)
    const s = await prisma.focusSession.findFirstOrThrow({ where: { state: 'running' } })
    await bot.press(A, `out:${s.id}:done`)

    const summary = await buildSummary(prisma, u, workDayKey(bot.now(), u.timezone))
    expect(summary.taskTimes).toEqual([
      { title: 'Написать отчёт', minutes: 20, completed: true },
      { title: 'Слайды для клиента', minutes: 20, completed: false },
    ])
  })

  it('«закончил …, иду отдыхать» не отдаёт всю сессию последней задаче', async () => {
    const bot = makeBot()
    await bot.onboard(A)
    const u = await user()
    const first = await prisma.task.create({ data: { userId: u.id, title: 'Написать отчёт', createdAt: bot.now() } })
    const second = await prisma.task.create({ data: { userId: u.id, title: 'Слайды для клиента', createdAt: bot.now() } })
    await bot.press(A, `task:${first.id}:start`)
    bot.advance(20)
    await bot.press(A, `task:${second.id}:start`)
    bot.advance(15)

    await bot.text(A, 'закончил слайды и иду отдыхать')

    const summary = await buildSummary(prisma, u, workDayKey(bot.now(), u.timezone))
    expect(summary.taskTimes).toEqual([
      { title: 'Написать отчёт', minutes: 20, completed: false },
      { title: 'Слайды для клиента', minutes: 15, completed: true },
    ])
  })

  it('кнопки «Время вышло» работают, даже если бот ждал другого ответа', async () => {
    const bot = makeBot()
    await bot.onboard(A)
    await bot.text(A, 'Начать сессию')
    const s = await prisma.focusSession.findFirstOrThrow({ where: { state: 'running' } })
    await bot.press(A, 'tasks::add')
    bot.advance(41)
    await runOutboxOnce(bot.ctx)

    expect(await user()).toMatchObject({ pendingInput: `session_end:${s.id}` })
    await bot.text(A, 'ещё поработаю')
    expect(await prisma.task.count()).toBe(0)

    await bot.press(A, `end:${s.id}:continue`)
    expect(bot.lastText(A)).toContain('ещё 15 минут')
    await bot.press(A, `end:${s.id}:continue`)
    expect(bot.lastText(A)).toBe('Это уже неактуально.')
  })

  it('свободный режим: пропущенные проверки засчитывают время до первой пропущенной', async () => {
    const bot = makeBot()
    await bot.onboard(A)
    await prisma.user.update({ where: { id: (await user()).id }, data: { technique: 'free' } })
    await bot.text(A, 'глава')
    await bot.press(A, bot.lastButton(A, 'len:', ':ok'))
    const s = await prisma.focusSession.findFirstOrThrow({ where: { state: 'running' } })
    for (let i = 0; i < 3; i++) {
      bot.advance(30)
      await runOutboxOnce(bot.ctx)
    }

    const closed = await prisma.focusSession.findUniqueOrThrow({ where: { id: s.id } })
    expect(closed).toMatchObject({ state: 'finished', counted: true })
    expect(bot.lastText(A)).toContain('засчитал')
  })

  it('названные 5 минут поднимаются до 10 — порога засчёта', async () => {
    const bot = makeBot()
    await bot.onboard(A)
    await bot.text(A, 'проверить почту, 5 минут')
    expect(await prisma.focusSession.findFirstOrThrow({ where: { state: 'running' } })).toMatchObject({ plannedMinutes: 10 })
  })
})
