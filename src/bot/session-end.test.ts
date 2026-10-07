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
    await bot.setupOnboarded(A)
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
    await bot.setupOnboarded(A)
    await bot.textAs(A, 'Начать сессию', {"text":"Начать сессию","route":"control","action":"focus","value":null,"followUp":null})
    bot.advance(25)

    await bot.textAs(A, 'готово, иду отдыхать', {"route": "end_session", "text": "готово, иду отдыхать", "outcome": "done", "outcomeSource": "готово", "completedTask": null, "completionSource": null, "rest": true, "minutes": null, "durationSource": null, "followUp": null})

    const s = await prisma.focusSession.findFirstOrThrow({ where: { userId: (await user()).id } })
    expect(s).toMatchObject({ state: 'finished', counted: true, restChoice: 'rest' })
    expect(bot.lastText(A)).toContain('Отдыхай')
    expect(bot.lastText(A)).not.toContain('неактуально')
  })

  it('«не закончил, пойду отдыхать» — перерыв, задача остаётся открытой', async () => {
    const bot = makeBot()
    await bot.setupOnboarded(A)
    await bot.textAs(A, '/focus Написать отчёт по продажам', {"text":"/focus Написать отчёт по продажам","route":"new_task","intent":{"task":null,"title":"Написать отчёт по продажам","scope":"step"},"minutes":null,"durationSource":null,"followUp":null})
    await bot.press(A, bot.lastButton(A, 'len:', ':ok'))
    bot.advance(20)

    await bot.textAs(A, 'не закончил, пойду отдыхать', {"text":"не закончил, пойду отдыхать","route":"break","minutes":null,"durationSource":null,"followUp":null})

    expect(await prisma.task.findMany({ select: { status: true } })).toEqual([{ status: 'active' }])
    expect(await prisma.focusSession.findFirstOrThrow()).toMatchObject({ state: 'paused', outcome: null })
  })

  it('«сделал и иду отдыхать» завершает сессию, но не утверждает готовность всей задачи', async () => {
    const bot = makeBot()
    await bot.setupOnboarded(A)
    await bot.textAs(A, '/focus Написать отчёт по продажам', {"text":"/focus Написать отчёт по продажам","route":"new_task","intent":{"task":null,"title":"Написать отчёт по продажам","scope":"step"},"minutes":null,"durationSource":null,"followUp":null})
    await bot.press(A, bot.lastButton(A, 'len:', ':ok'))
    bot.advance(20)

    await bot.textAs(A, 'сделал и иду отдыхать', {"route": "end_session", "text": "сделал и иду отдыхать", "outcome": "done", "outcomeSource": "сделал", "completedTask": null, "completionSource": null, "rest": true, "minutes": null, "durationSource": null, "followUp": null})

    expect(await prisma.task.findMany({ select: { title: true, status: true } })).toEqual([{ title: 'Написать отчёт по продажам', status: 'active' }])
    expect(await prisma.focusSession.findFirstOrThrow()).toMatchObject({ state: 'finished', outcome: 'done' })
  })

  it('«закончил отчёт и иду отдыхать» узнаёт задачу своими словами', async () => {
    const bot = makeBot()
    await bot.setupOnboarded(A)
    await bot.textAs(A, '/focus Написать отчёт по продажам', {"text":"/focus Написать отчёт по продажам","route":"new_task","intent":{"task":null,"title":"Написать отчёт по продажам","scope":"step"},"minutes":null,"durationSource":null,"followUp":null})
    await bot.press(A, bot.lastButton(A, 'len:', ':ok'))
    bot.advance(20)

    await bot.textAs(A, 'закончил отчёт и иду отдыхать', {"route": "end_session", "text": "закончил отчёт и иду отдыхать", "outcome": "done", "outcomeSource": "закончил отчёт", "completedTask": "t1", "completionSource": "закончил отчёт", "rest": true, "minutes": null, "durationSource": null, "followUp": null})

    expect(await prisma.task.findMany({ select: { title: true, status: true } })).toEqual([{ title: 'Написать отчёт по продажам', status: 'done' }])
  })

  it('закрытая посреди сессии задача перестаёт копить время', async () => {
    const bot = makeBot()
    await bot.setupOnboarded(A)
    const u = await user()
    const first = await prisma.task.create({ data: { userId: u.id, title: 'Написать отчёт', createdAt: bot.now() } })
    const second = await prisma.task.create({ data: { userId: u.id, title: 'Слайды для клиента', createdAt: new Date(bot.now().getTime() + 1) } })
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
    await bot.setupOnboarded(A)
    const u = await user()
    const first = await prisma.task.create({ data: { userId: u.id, title: 'Написать отчёт', createdAt: bot.now() } })
    const second = await prisma.task.create({ data: { userId: u.id, title: 'Слайды для клиента', createdAt: new Date(bot.now().getTime() + 1) } })
    await bot.press(A, `task:${first.id}:start`)
    bot.advance(20)
    await bot.press(A, `task:${second.id}:start`)
    bot.advance(15)

    await bot.textAs(A, 'закончил слайды и иду отдыхать', {"route": "end_session", "text": "закончил слайды и иду отдыхать", "outcome": "done", "outcomeSource": "закончил слайды", "completedTask": "t1", "completionSource": "закончил слайды", "rest": true, "minutes": null, "durationSource": null, "followUp": null})

    const summary = await buildSummary(prisma, u, workDayKey(bot.now(), u.timezone))
    expect(summary.taskTimes).toEqual([
      { title: 'Написать отчёт', minutes: 20, completed: false },
      { title: 'Слайды для клиента', minutes: 15, completed: true },
    ])
  })

  it('/today посреди сессии: без исхода, время — до планового конца, и в итоге столько же', async () => {
    const bot = makeBot()
    await bot.setupOnboarded(A)
    await bot.textAs(A, 'глава, 25 минут', {"text":"глава, 25 минут","route":"new_task","intent":{"task":null,"title":"глава","scope":"step"},"minutes":25,"durationSource":"25 минут","followUp":null})
    const s = await prisma.focusSession.findFirstOrThrow({ where: { state: 'running' } })
    bot.advance(50)

    await bot.textAs(A, '/today', {"text":"/today","route":"close_day","followUp":null})

    expect(await prisma.focusSession.findUniqueOrThrow({ where: { id: s.id } })).toMatchObject({ state: 'finished', outcome: null, counted: true, restChoice: 'day_end' })
    const summary = bot.textsTo(A).find((text) => text.includes('По задачам:'))
    expect(summary).toContain('• глава — 25 минут')
    expect(summary).not.toContain('пока не готово')
  })

  it('«✅ Завершить» на перерыве закрывает задачу, но не сессию', async () => {
    const bot = makeBot()
    await bot.setupOnboarded(A)
    const u = await user()
    const task = await prisma.task.create({ data: { userId: u.id, title: 'Слайды' } })
    await bot.press(A, `task:${task.id}:start`)
    bot.advance(20)
    await bot.textAs(A, 'Перерыв', {"text":"Перерыв","route":"break","minutes":null,"durationSource":null,"followUp":null})

    await bot.press(A, `task:${task.id}:done`)

    expect(await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).toMatchObject({ status: 'done' })
    expect(await prisma.focusSession.findFirstOrThrow({ where: { userId: u.id } })).toMatchObject({ state: 'paused', taskId: null })
    expect(bot.lastText(A)).toContain('Ты на перерыве')
  })

  it('кнопки «Время вышло» работают, даже если бот ждал другого ответа', async () => {
    const bot = makeBot()
    await bot.setupOnboarded(A)
    await bot.textAs(A, 'Начать сессию', {"text":"Начать сессию","route":"control","action":"focus","value":null,"followUp":null})
    const s = await prisma.focusSession.findFirstOrThrow({ where: { state: 'running' } })
    await bot.press(A, 'tasks::add')
    bot.advance(41)
    await runOutboxOnce(bot.ctx)

    expect(await user()).toMatchObject({ pendingInput: `session_end:${s.id}` })
    await bot.textAs(A, 'ещё поработаю', {"text":"ещё поработаю","route":"continue_same","minutes":null,"durationSource":null,"followUp":null})
    expect(await prisma.task.count()).toBe(0)

    expect(await prisma.focusSession.findUniqueOrThrow({where:{id:s.id}})).toMatchObject({plannedEndAt:new Date(bot.now().getTime()+15*60000)})
    await bot.press(A, `end:${s.id}:continue`)
    expect(bot.lastText(A)).toBe('Это уже неактуально.')
    await bot.press(A, `end:${s.id}:continue`)
    expect(bot.lastText(A)).toBe('Это уже неактуально.')
  })

  it('свободный режим: пропущенные проверки засчитывают время до первой пропущенной', async () => {
    const bot = makeBot()
    await bot.setupOnboarded(A)
    await prisma.user.update({ where: { id: (await user()).id }, data: { technique: 'free' } })
    await bot.textAs(A, 'глава', {"text":"глава","route":"new_task","intent":{"task":null,"title":"глава","scope":"step"},"minutes":null,"durationSource":null,"followUp":null})
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
    await bot.setupOnboarded(A)
    await bot.textAs(A, 'проверить почту, 5 минут', {"text":"проверить почту, 5 минут","route":"new_task","intent":{"task":null,"title":"проверить почту","scope":"step"},"minutes":10,"durationSource":"5 минут","followUp":null})
    expect(await prisma.focusSession.findFirstOrThrow({ where: { state: 'running' } })).toMatchObject({ plannedMinutes: 10 })
  })
})
