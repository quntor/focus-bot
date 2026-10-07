import { control, work, rest } from '../test/semantic-provider.js'
import { beforeEach, describe, expect, it } from 'vitest'
import type { LlmProvider } from '../llm/provider.js'
import { prisma, hasDb, resetDb } from '../test/db.js'
import { makeBot } from '../test/bot.js'
import { handleUpdate } from '../tg/webhook.js'
import { workDayKey } from '../lib/day.js'
import { buildSummary } from './day-flow.js'
import { T } from './texts.js'

const A = 6101

function provider(responses: {
  tasks?: string
  intent?: string
  report?: string
  sessionHelp?: string
}): LlmProvider {
  return {
    enabled: true,
    model: 'test-model',
    async complete(req) {
      if (req.system.includes('сообщение пользователя фокус-боту')) {
        return {
          text: responses.tasks ?? '{"kind":"session_intent","new_tasks":[],"start_title":null,"complete_title":null}',
          usage: null,
        }
      }
      if (req.system.includes('намерение пользователя перед рабочей сессией')) {
        return {
          text: responses.intent ?? '{"task":null,"title":"Новая работа","scope":"step"}',
          usage: null,
        }
      }
      if (req.system.includes('короткий отчёт пользователя')) {
        return {
          text: responses.report ?? '{"progress":"stuck","next_step":null,"allocations":[],"continue_now":false}',
          usage: null,
        }
      }
      if (req.system.includes('активной фокус-сессии')) {
        return {
          text: responses.sessionHelp ?? '{"kind":"other","reply":null,"action":null,"task_title":null}',
          usage: null,
        }
      }
      throw new Error('unexpected LLM call')
    },
  }
}

describe.skipIf(!hasDb)('границы недопониманий', () => {
  beforeEach(resetDb)

  it('отмена предложения длительности не оставляет новую задачу', async () => {
    const bot = makeBot()
    await bot.setupOnboarded(A)

    await bot.textAs(A, 'Мониторинг', work('Мониторинг','Мониторинг',null,null,null))
    expect(await prisma.task.count()).toBe(0)
    await bot.press(A, bot.lastButton(A, 'len:', ':cancel'))

    expect(await prisma.task.count()).toBe(0)
    expect(bot.lastText(A)).toBe('Старт отменил. Новую задачу не сохранял.')
  })

  it('не объединяет новое название с семантически похожей задачей без явного совпадения', async () => {
    const bot = makeBot({
      llm: provider({ intent: '{"task":"t1","title":"Инкитт","scope":"step"}' }),
    })
    await bot.setupOnboarded(A)
    const user = await prisma.user.findUniqueOrThrow({ where: { tgId: BigInt(A) } })
    const monitoring = await prisma.task.create({ data: { userId: user.id, title: 'Мониторинг', createdAt: bot.now() } })

    await bot.textAs(A, 'Инкитт', work('Инкитт','Инкитт',null,null,null))
    expect(await prisma.task.count({ where: { userId: user.id } })).toBe(1)
    await bot.press(A, bot.lastButton(A, 'len:', ':ok'))

    const running = await prisma.focusSession.findFirstOrThrow({ where: { userId: user.id, state: 'running' } })
    const tasks = await prisma.task.findMany({ where: { userId: user.id }, orderBy: { createdAt: 'asc' } })
    expect(tasks.map((task) => task.title)).toEqual(['Мониторинг', 'Инкитт'])
    expect(running.taskId).not.toBe(monitoring.id)
  })

  it('коррекцию с явным названием подтверждает каноническим названием задачи', async () => {
    const bot = makeBot({
      llm: provider({ intent: '{"task":"t1","title":"это не та работа, я имел в виду мониторинг","scope":"step"}' }),
    })
    await bot.setupOnboarded(A)
    const user = await prisma.user.findUniqueOrThrow({ where: { tgId: BigInt(A) } })
    const monitoring = await prisma.task.create({ data: { userId: user.id, title: 'Мониторинг', createdAt: bot.now() } })

    await bot.textAs(A, 'это не та работа, я имел в виду мониторинг', work('это не та работа, я имел в виду мониторинг','Мониторинг',null,null,'t1'))
    await bot.press(A, bot.lastButton(A, 'len:', ':ok'))

    const running = await prisma.focusSession.findFirstOrThrow({ where: { userId: user.id, state: 'running' } })
    expect(running).toMatchObject({ taskId: monitoring.id, intentText: 'Мониторинг' })
    expect(bot.lastText(A)).toContain('Сессия «Мониторинг» началась')
  })

  it('отчёт с намерением продолжить предлагает явный старт той же задачи', async () => {
    const bot = makeBot({
      llm: provider({
        intent: '{"task":null,"title":"Мониторинг","scope":"step"}',
        report: '{"progress":"stuck","next_step":"продолжить проверку","allocations":[],"continue_now":true}',
      }),
    })
    await bot.setupOnboarded(A)
    await bot.textAs(A, 'Мониторинг', work('Мониторинг','Мониторинг',null,null,null))
    await bot.press(A, bot.lastButton(A, 'len:', ':ok'))
    const first = await prisma.focusSession.findFirstOrThrow({ where: { state: 'running' } })
    bot.advance(40)
    await bot.press(A, `out:${first.id}:not_done`)

    await bot.textAs(A, 'Не хватило времени, продолжаю работу', {route:'report',text:'Не хватило времени, продолжаю работу',report:{route:'report',progress:'stuck',next_step:'продолжить проверку',allocations:[],continue_now:true,continue_minutes:null},followUp:null})

    expect(await prisma.focusSession.count({ where: { state: { in: ['collecting_intent', 'running', 'paused'] } } })).toBe(0)
    expect(bot.lastButton(A, 'again:', ':same')).toBe(`again:${first.id}:same`)
    expect(bot.lastText(A)).toContain('Таймер ещё не запущен')

    await bot.press(A, `again:${first.id}:same`)

    const second = await prisma.focusSession.findFirstOrThrow({ where: { state: 'running' } })
    expect(second.taskId).toBe(first.taskId)
    expect(await prisma.focusSession.findUniqueOrThrow({ where: { id: first.id } })).toMatchObject({ restChoice: 'continue' })
  })

  it('«ещё 15 минут» в отчёте задаёт новый заход, а не перераспределяет прошлое время', async () => {
    const bot = makeBot({
      llm: provider({
        intent: '{"task":null,"title":"Раздельное сканирование марок в Милавице","scope":"step"}',
        report: '{"progress":"stuck","next_step":"поправить косяки","continue_now":true,"continue_minutes":15,"allocations":[]}',
      }),
    })
    await bot.setupOnboarded(A)
    await bot.textAs(A, 'Раздельное сканирование марок в Милавице', work('Раздельное сканирование марок в Милавице','Раздельное сканирование марок в Милавице',null,null,null))
    await bot.press(A, bot.lastButton(A, 'len:', ':ok'))
    const first = await prisma.focusSession.findFirstOrThrow({ where: { state: 'running' } })
    bot.advance(55)
    await bot.press(A, `out:${first.id}:not_done`)

    await bot.textAs(A, 'Мне ещё нужно 15 минут поправить косяки', {route:'continue_same',text:'Мне ещё нужно 15 минут поправить косяки',minutes:15,durationSource:'15 минут',followUp:null})

    expect(await prisma.taskTimeAllocation.count({ where: { sessionId: first.id } })).toBe(0)
    expect(bot.textsTo(A).some((text) => text.includes('Распределил 15 минут'))).toBe(false)
    expect(await prisma.focusSession.findUniqueOrThrow({where:{id:first.id}})).toMatchObject({reportText:null})

    expect(await prisma.focusSession.findFirstOrThrow({ where: { state: 'running' } })).toMatchObject({
      taskId: first.taskId,
      plannedMinutes: 15,
      minutesSource: 'user',
    })
  })

  it('жалоба о состоянии не становится задачей и не меняет ожидаемый ввод', async () => {
    const bot = makeBot({
      llm: provider({ tasks: '{"kind":"feedback","new_tasks":[],"start_title":null,"complete_title":null}' }),
    })
    await bot.setupOnboarded(A)

    await bot.textAs(A, 'Какого фига сессия не идёт? Я тебе не ответил, с чего продолжу?', {route:'feedback',text:'Какого фига сессия не идёт? Я тебе не ответил, с чего продолжу?',followUp:null})

    const session = await prisma.focusSession.findFirstOrThrow({ where: { state: 'collecting_intent' } })
    expect(session.intentText).toBeNull()
    expect(await prisma.task.count()).toBe(0)
    expect(bot.lastText(A)).toBe(T.feedback)
  })

  it('завершает названную задачу и сессию в момент явного ухода на отдых', async () => {
    const bot = makeBot({
      llm: provider({
        sessionHelp: '{"kind":"complete_and_rest","reply":null,"action":null,"task_title":"починить форму оплаты на сайте"}',
      }),
    })
    await bot.setupOnboarded(A)
    await bot.textAs(A, 'Начать сессию', control('Начать сессию','focus'))
    const running = await prisma.focusSession.findFirstOrThrow({ where: { state: 'running' } })
    bot.advance(25)

    await bot.textAs(A, 'Я сделал задачу починить форму оплаты на сайте теперь отдыхаю', {route:'end_session',text:'Я сделал задачу починить форму оплаты на сайте теперь отдыхаю',outcome:'done',outcomeSource:'Я сделал',completedTask:null,completedTitle:'починить форму оплаты на сайте',completionSource:'Я сделал задачу починить форму оплаты на сайте',rest:true,minutes:null,durationSource:null,followUp:null})

    const finished = await prisma.focusSession.findUniqueOrThrow({ where: { id: running.id } })
    expect(finished).toMatchObject({ state: 'finished', outcome: 'done', restChoice: 'rest', finishedAt: bot.now() })
    const task = await prisma.task.findFirstOrThrow({ where: { userId: running.userId } })
    expect(task).toMatchObject({ title: 'починить форму оплаты на сайте', status: 'done' })
    const owner = await prisma.user.findUniqueOrThrow({ where: { id: running.userId } })
    const summary = await buildSummary(prisma, owner, workDayKey(bot.now(), owner.timezone))
    expect(summary.taskTimes).toEqual([{ title: task.title, minutes: 25, completed: true }])
    expect(await prisma.user.findUniqueOrThrow({ where: { id: running.userId } })).toMatchObject({ pendingInput: 'report_text' })
    expect(bot.lastText(A)).toContain('Пара слов — что вышло?')

    await bot.textAs(A, 'Устранил ошибку и проверил на стенде', {route:'report',text:'Устранил ошибку и проверил на стенде',report:{route:'report',progress:'moved',next_step:null,continue_now:false,continue_minutes:null,allocations:[]},followUp:null})
    expect(await prisma.focusSession.findUniqueOrThrow({ where: { id: running.id } })).toMatchObject({
      reportText: 'Устранил ошибку и проверил на стенде',
      restChoice: 'rest',
    })
    expect(bot.textsTo(A).filter((message) => message.startsWith('Записал. Отдохнёшь'))).toHaveLength(0)
  })

  it('явное «приступаю» запускает новый таймер даже из перерыва', async () => {
    const bot = makeBot({
      llm: provider({ tasks: '{"kind":"start_task","new_tasks":[],"start_title":"Интервью","complete_title":null}' }),
    })
    await bot.setupOnboarded(A)
    const user = await prisma.user.findUniqueOrThrow({ where: { tgId: BigInt(A) } })
    const task = await prisma.task.create({ data: { userId: user.id, title: 'Интервью', createdAt: bot.now() } })
    await bot.textAs(A, 'Начать сессию', control('Начать сессию','focus'))
    const previous = await prisma.focusSession.findFirstOrThrow({ where: { state: 'running' } })
    bot.advance(5)
    await bot.textAs(A, 'Перерыв', rest('Перерыв'))

    await bot.textAs(A, 'Приступаю к интервью', work('Приступаю к интервью','Интервью',null,null,'t1'))
    await bot.press(A, bot.lastButton(A, 'len:', ':ok'))

    expect(await prisma.focusSession.findUniqueOrThrow({ where: { id: previous.id } })).toMatchObject({ state: 'finished', outcome: null })
    const running = await prisma.focusSession.findFirstOrThrow({ where: { state: 'running' } })
    expect(running).toMatchObject({ taskId: task.id, intentText: 'Интервью', startedAt: bot.now() })
  })

  it('отбрасывает решение LLM, если состояние изменилось за время запроса', async () => {
    let release!: () => void
    let started!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const entered = new Promise<void>((resolve) => { started = resolve })
    const llm: LlmProvider = {
      enabled: true,
      model: 'test-model',
      async complete(req) {
        if (!req.system.includes('семантический маршрутизатор')) throw new Error('unexpected LLM call')
        started()
        await gate
        return { text: JSON.stringify(work('Начни Инкитт','Инкитт')), usage: null }
      },
    }
    const bot = makeBot({ llm })
    await bot.setupOnboarded(A)

    const parsing = bot.text(A, 'Начни Инкитт')
    await entered
    const newer = bot.textAs(A, T.sessionStartButton, control(T.sessionStartButton,'focus'))
    release()
    await parsing
    await newer

    const running = await prisma.focusSession.findFirstOrThrow({ where: { state: 'running' } })
    expect(running.taskId).toBeNull()
    expect(await prisma.task.count()).toBe(0)
    expect(await prisma.event.count({ where: { type: 'route_stale' } })).toBe(1)
  })

  it('на фото и стикер отвечает, а не молчит', async () => {
    const bot = makeBot()
    await bot.setupOnboarded(A)

    await handleUpdate(bot.ctx, { update_id: 990001, message: { photo: [{ file_id: 'p' }], from: { id: A }, chat: { id: A, type: 'private' } } })

    expect(bot.lastText(A)).toBe(T.unsupported)
  })

  it('сверх лимита частоты пишет «Слишком быстро» один раз, а не на каждое сообщение', async () => {
    const bot = makeBot()
    await bot.setupOnboarded(A)
    bot.advance(1)

    for (let i = 0; i < 34; i++) await bot.text(A, '/help')

    expect(bot.textsTo(A).filter((text) => text === T.tooFast)).toHaveLength(1)
  })
})
