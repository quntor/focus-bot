import { beforeEach, describe, expect, it } from 'vitest'
import { hasDb, prisma, resetDb } from '../test/db.js'
import { makeBot } from '../test/bot.js'
import { runOutboxOnce } from '../outbox/worker.js'
import type { LlmProvider } from '../llm/provider.js'

const A = 1001

describe.skipIf(!hasDb)('полный цикл сессии', () => {
  beforeEach(resetDb)

  it('знакомство → намерение → предложение → пинг → исход → отчёт → отдых', async () => {
    const bot = makeBot()
    await bot.onboard(A)
    expect(bot.lastText(A)).toContain('С чего начнёшь?')

    const user = await prisma.user.findUniqueOrThrow({ where: { tgId: BigInt(A) } })
    expect(user.consentAt).toBeNull()
    expect(user.timezone).toBe('Europe/Moscow')

    await bot.text(A, 'набросать план главы')
    expect(bot.lastText(A)).toBe('Давай 40 минут работы, потом 10 отдыха.')
    await bot.press(A, bot.lastButton(A, 'len:', ':ok'))
    expect(bot.lastText(A)).toContain('Поехали')

    const session = await prisma.focusSession.findFirstOrThrow({ where: { userId: user.id } })
    expect(session.state).toBe('running')
    expect(session.plannedMinutes).toBe(40)
    expect(session.minutesSource).toBe('bot')

    bot.advance(20)
    await runOutboxOnce(bot.ctx)
    expect(bot.lastText(A)).toBe('На месте?')
    await bot.press(A, bot.lastButton(A, 'ping:', ':here'))

    bot.advance(20)
    await runOutboxOnce(bot.ctx)
    expect(bot.lastText(A)).toBe('Время! Как прошло?')
    await bot.press(A, `out:${session.id}:done`)
    expect(bot.lastText(A)).toContain('Пара слов')

    await bot.text(A, 'план готов, дальше введение')
    expect(bot.lastText(A)).toBe('Записал. Отдохнёшь 10 минут?')
    await bot.press(A, `rest:${session.id}:rest`)
    expect(bot.lastText(A)).toContain('Отдыхай')

    bot.advance(10)
    await runOutboxOnce(bot.ctx)
    expect(bot.lastText(A)).toBe('Отдых закончился. С чего продолжишь?')

    const done = await prisma.focusSession.findUniqueOrThrow({ where: { id: session.id } })
    expect(done.state).toBe('finished')
    expect(done.outcome).toBe('done')
    expect(done.counted).toBe(true)
    expect(done.reportText).toBe('план готов, дальше введение')
    const points = await prisma.pointsEntry.findMany({ where: { userId: user.id } })
    expect(points.map((p) => [p.reason, p.amount])).toEqual([['session_completed', 10]])
    const streak = await prisma.streak.findUniqueOrThrow({ where: { userId: user.id } })
    expect(streak.current).toBe(1)
  })

  it('названное время принимается без переспрашивания', async () => {
    const bot = makeBot()
    await bot.onboard(A)
    await bot.text(A, 'допишу раздел, за час')
    expect(bot.lastText(A)).toContain('Час работы, потом 10 отдыха')
    const s = await prisma.focusSession.findFirstOrThrow({})
    expect(s.state).toBe('running')
    expect(s.plannedMinutes).toBe(60)
    expect(s.minutesSource).toBe('user')
  })

  it('«всё, на сегодня» — итог дня и назначение встречи, не тишина', async () => {
    const bot = makeBot()
    await bot.onboard(A)
    await bot.text(A, '/today')
    expect(bot.lastText(A)).toContain('Когда встретимся')
    const meeting = await prisma.outboxMessage.findFirst({ where: { kind: 'meeting', status: 'pending' } })
    expect(meeting).not.toBeNull()
  })

  it('после вопроса о встрече понимает свободный текст «начну сегодня в 11»', async () => {
    const bot = makeBot({ now: new Date('2026-09-27T06:55:00Z') })
    await bot.onboard(A, '09:55')
    await bot.text(A, '/today')

    await bot.text(A, 'Начну сегодня в 11')

    const user = await prisma.user.findUniqueOrThrow({ where: { tgId: BigInt(A) } })
    expect(await prisma.outboxMessage.findFirstOrThrow({ where: { userId: user.id, kind: 'meeting', status: 'pending' } })).toMatchObject({
      sendAfter: new Date('2026-09-27T08:00:00Z'),
      payload: { defaulted: false, morning: false },
    })
    expect(await prisma.focusSession.count({ where: { userId: user.id, state: { in: ['collecting_intent', 'running', 'paused'] } } })).toBe(0)
    expect(bot.lastText(A)).toBe('Договорились: сегодня в 11:00.')
  })

  it('после вопроса о встрече voice «начну сегодня в 11» не запускает задачу', async () => {
    const transcript = 'Начну сегодня в 11'
    const llm: LlmProvider = {
      enabled: true,
      model: 'test-model',
      async complete() {
        return { text: '{"kind":"start_task","new_tasks":[],"start_title":"Запустить умные функции на фокус-бот","complete_title":null}', usage: null }
      },
    }
    const bot = makeBot({
      now: new Date('2026-09-27T06:55:00Z'),
      llm,
      stt: { enabled: true, model: 'test-stt', async transcribe() { return transcript } },
    })
    bot.tg.downloads.set('voice-meeting-time', new Uint8Array([1, 2, 3]))
    await bot.onboard(A, '09:55')
    await bot.text(A, '/today')

    await bot.voice(A, { fileId: 'voice-meeting-time', duration: 6, mimeType: 'audio/ogg', fileSize: 3 })

    const user = await prisma.user.findUniqueOrThrow({ where: { tgId: BigInt(A) } })
    expect(await prisma.outboxMessage.findFirstOrThrow({ where: { userId: user.id, kind: 'meeting', status: 'pending' } })).toMatchObject({
      sendAfter: new Date('2026-09-27T08:00:00Z'),
      payload: { defaulted: false, morning: false },
    })
    expect(await prisma.focusSession.count({ where: { userId: user.id, state: { in: ['collecting_intent', 'running', 'paused'] } } })).toBe(0)
    expect(await prisma.task.count({ where: { userId: user.id } })).toBe(0)
    expect(bot.lastText(A)).toBe('Договорились: сегодня в 11:00.')
  })

  it('voice-отчёт сохраняет результат и назначает явно названную встречу на завтра', async () => {
    const transcript = 'релиз готов завтра надо будет тестировать начинаем завтра 8:30'
    const bot = makeBot({
      now: new Date('2026-09-27T12:20:00Z'),
      stt: { enabled: true, model: 'test-stt', async transcribe() { return transcript } },
    })
    bot.tg.downloads.set('voice-report-and-meeting', new Uint8Array([1, 2, 3]))
    await bot.onboard(A, '15:20')
    await bot.text(A, 'Запустить умные функции на боте')
    await bot.press(A, bot.lastButton(A, 'len:', ':ok'))
    const session = await prisma.focusSession.findFirstOrThrow({ where: { state: 'running' } })
    bot.advance(40)
    await runOutboxOnce(bot.ctx)
    await bot.press(A, `out:${session.id}:done`)

    await bot.voice(A, { fileId: 'voice-report-and-meeting', duration: 14, mimeType: 'audio/ogg', fileSize: 3 })

    const user = await prisma.user.findUniqueOrThrow({ where: { tgId: BigInt(A) } })
    expect(await prisma.focusSession.findUniqueOrThrow({ where: { id: session.id } })).toMatchObject({
      reportText: transcript,
      progress: 'moved',
      restChoice: 'day_end',
    })
    expect(await prisma.focusSession.count({ where: { userId: user.id, state: { in: ['collecting_intent', 'running', 'paused'] } } })).toBe(0)
    expect(await prisma.outboxMessage.findFirstOrThrow({ where: { userId: user.id, kind: 'meeting', status: 'pending' } })).toMatchObject({
      sendAfter: new Date('2026-09-28T05:30:00Z'),
      payload: { defaulted: false, morning: false },
    })
    expect(await prisma.outboxMessage.count({ where: { userId: user.id, kind: 'rest_over', status: 'pending' } })).toBe(0)
    expect(bot.lastText(A)).toContain('Договорились: завтра в 08:30.')
  })

  it('обычный voice-отчёт не уходит в task-intent и сохраняет прежний вопрос про отдых', async () => {
    const transcript = 'релиз готов, завтра проверю основные сценарии'
    const bot = makeBot({
      stt: { enabled: true, model: 'test-stt', async transcribe() { return transcript } },
    })
    bot.tg.downloads.set('voice-report', new Uint8Array([1, 2, 3]))
    await bot.onboard(A)
    await bot.text(A, 'Подготовить релиз')
    await bot.press(A, bot.lastButton(A, 'len:', ':ok'))
    const session = await prisma.focusSession.findFirstOrThrow({ where: { state: 'running' } })
    bot.advance(40)
    await runOutboxOnce(bot.ctx)
    await bot.press(A, `out:${session.id}:done`)

    await bot.voice(A, { fileId: 'voice-report', duration: 7, mimeType: 'audio/ogg', fileSize: 3 })

    expect(await prisma.focusSession.findUniqueOrThrow({ where: { id: session.id } })).toMatchObject({
      reportText: transcript,
      progress: 'moved',
      restChoice: null,
    })
    expect(await prisma.focusSession.count({ where: { state: { in: ['collecting_intent', 'running', 'paused'] } } })).toBe(0)
    expect(bot.lastText(A)).toBe('Записал. Отдохнёшь 10 минут?')
  })

  it('число без явного «сегодня/завтра» в отчёте не превращается во встречу', async () => {
    const bot = makeBot({ now: new Date('2026-09-27T12:20:00Z') })
    await bot.onboard(A)
    await bot.text(A, 'Подготовить релиз')
    await bot.press(A, bot.lastButton(A, 'len:', ':ok'))
    const session = await prisma.focusSession.findFirstOrThrow({ where: { state: 'running' } })
    bot.advance(40)
    await runOutboxOnce(bot.ctx)
    await bot.press(A, `out:${session.id}:done`)

    await bot.text(A, 'проверил 8:30 минут лога, проблема найдена')

    expect(await prisma.focusSession.findUniqueOrThrow({ where: { id: session.id } })).toMatchObject({
      reportText: 'проверил 8:30 минут лога, проблема найдена',
      restChoice: null,
    })
    expect(await prisma.outboxMessage.count({ where: { kind: 'meeting', status: 'pending' } })).toBe(0)
    expect(bot.lastText(A)).toBe('Записал. Отдохнёшь 10 минут?')
  })

  it('свободная фраза закрывает день, останавливает таймер и показывает время по задачам', async () => {
    const llm: LlmProvider = {
      enabled: true,
      model: 'test-model',
      async complete(req) {
        if (req.system.includes('сообщение пользователя фокус-боту')) {
          return { text: '{"kind":"close_day","new_tasks":[],"start_title":null}', usage: null }
        }
        throw new Error('unexpected LLM call')
      },
    }
    const phrase = 'Мозг всё, лавочка закрыта до завтра'
    const bot = makeBot({ llm, stt: { enabled: true, model: 'test-stt', async transcribe() { return phrase } } })
    bot.tg.downloads.set('voice-close-day', new Uint8Array([1, 2, 3]))
    await bot.onboard(A)
    const user = await prisma.user.findUniqueOrThrow({ where: { tgId: BigInt(A) } })
    const task = await prisma.task.create({ data: { userId: user.id, title: 'Сделать презентацию' } })
    await bot.press(A, `task:${task.id}:start`)
    bot.advance(17)

    await bot.voice(A, { fileId: 'voice-close-day', duration: 4, mimeType: 'audio/ogg', fileSize: 3 })

    expect(await prisma.focusSession.findFirstOrThrow({ where: { userId: user.id } })).toMatchObject({
      state: 'finished',
      outcome: 'not_done',
      restChoice: 'day_end',
      finishedAt: bot.now(),
    })
    expect(await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).toMatchObject({ status: 'active' })
    expect(bot.lastText(A)).toContain('По задачам:')
    expect(bot.lastText(A)).toContain('• Сделать презентацию — 17 минут')
    expect(await prisma.outboxMessage.count({ where: { userId: user.id, status: { in: ['pending', 'paused'] }, kind: { in: ['ping', 'session_end'] } } })).toBe(0)
  })

  it('сохраняет завершённую без таймера задачу и включает её в итог дня', async () => {
    const bot = makeBot()
    await bot.onboard(A)
    const user = await prisma.user.findUniqueOrThrow({ where: { tgId: BigInt(A) } })
    const task = await prisma.task.create({ data: { userId: user.id, title: 'Отправить документы' } })

    await bot.press(A, `task:${task.id}:done`)

    expect(await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).toMatchObject({ status: 'done' })
    expect(await prisma.task.count({ where: { id: task.id } })).toBe(1)
    expect(await prisma.event.findFirst({ where: { type: 'task_completed' } })).toMatchObject({
      payload: { task_id: task.id, source: 'button' },
    })

    await bot.text(A, '/today')

    const summary = bot.textsTo(A).find((text) => text.includes('По задачам:'))
    expect(summary).toContain('• Отправить документы — выполнено без таймера')
    expect(summary).not.toContain('Отправить документы — меньше минуты')
  })

  it('делит время одной рабочей сессии между задачами без перезапуска таймера', async () => {
    const bot = makeBot()
    await bot.onboard(A)
    const user = await prisma.user.findUniqueOrThrow({ where: { tgId: BigInt(A) } })
    const first = await prisma.task.create({ data: { userId: user.id, title: 'Разобрать обратную связь' } })
    const second = await prisma.task.create({ data: { userId: user.id, title: 'Исправить макет' } })

    await bot.press(A, `task:${first.id}:start`)
    const session = await prisma.focusSession.findFirstOrThrow({ where: { userId: user.id, state: 'running' } })
    const originalEnd = session.plannedEndAt
    bot.advance(12)
    await bot.press(A, `task:${second.id}:start`)
    expect(await prisma.focusSession.findUniqueOrThrow({ where: { id: session.id } })).toMatchObject({
      state: 'running',
      taskId: second.id,
      plannedEndAt: originalEnd,
    })
    bot.advance(8)

    await bot.text(A, '/today')

    const summary = bot.textsTo(A).find((text) => text.includes('По задачам:'))
    expect(summary).toContain('• Разобрать обратную связь — 12 минут')
    expect(summary).toContain('• Исправить макет — 8 минут')
  })

  it('первую задачу позднего старта считает с начала текущего рабочего периода', async () => {
    const bot = makeBot()
    await bot.onboard(A)
    const user = await prisma.user.findUniqueOrThrow({ where: { tgId: BigInt(A) } })
    const task = await prisma.task.create({ data: { userId: user.id, title: 'Подготовить презентацию' } })

    await bot.text(A, 'Начать сессию')
    const session = await prisma.focusSession.findFirstOrThrow({ where: { userId: user.id, state: 'running' } })
    expect(session.taskId).toBeNull()
    bot.advance(12)
    await bot.press(A, `task:${task.id}:start`)
    bot.advance(8)
    await bot.text(A, '/today')

    const summary = bot.textsTo(A).find((text) => text.includes('По задачам:'))
    expect(summary).toContain('• Подготовить презентацию — 20 минут')
  })

  it('позднее назначение после отдыха не захватывает предыдущий рабочий период', async () => {
    const bot = makeBot()
    await bot.onboard(A)
    const user = await prisma.user.findUniqueOrThrow({ where: { tgId: BigInt(A) } })
    const task = await prisma.task.create({ data: { userId: user.id, title: 'Разобрать документы' } })

    await bot.text(A, 'Начать сессию')
    bot.advance(10)
    await bot.text(A, 'Перерыв')
    bot.advance(15)
    await bot.text(A, 'Вернуться к работе')
    bot.advance(12)
    await bot.press(A, `task:${task.id}:start`)
    bot.advance(8)
    await bot.text(A, '/today')

    const summary = bot.textsTo(A).find((text) => text.includes('По задачам:'))
    expect(summary).toContain('• Разобрать документы — 20 минут')
    expect(summary).not.toContain('30 минут')
  })

  it('принимает постфактум распределение времени между задачами с остатком', async () => {
    const allocationLlm: LlmProvider = {
      enabled: true,
      model: 'test-model',
      async complete(req) {
        if (!req.system.includes('короткий отчёт пользователя')) throw new Error('unexpected LLM call')
        return {
          text: JSON.stringify({
            progress: 'moved',
            next_step: null,
            allocations: [
              { task: 't1', title: 'Подготовить презентацию', minutes: 15, remainder: false },
              { task: 't2', title: 'Ответить на письма', minutes: 5, remainder: false },
              { task: 't3', title: 'Собрать отчёт', minutes: null, remainder: true },
            ],
          }),
          usage: null,
        }
      },
    }
    const bot = makeBot({ llm: allocationLlm })
    await bot.onboard(A)
    const user = await prisma.user.findUniqueOrThrow({ where: { tgId: BigInt(A) } })
    await prisma.task.create({ data: { userId: user.id, title: 'Подготовить презентацию' } })
    await prisma.task.create({ data: { userId: user.id, title: 'Ответить на письма' } })
    await prisma.task.create({ data: { userId: user.id, title: 'Собрать отчёт' } })

    await bot.text(A, 'Начать сессию')
    const session = await prisma.focusSession.findFirstOrThrow({ where: { userId: user.id, state: 'running' } })
    bot.advance(40)
    await runOutboxOnce(bot.ctx)
    await bot.press(A, `out:${session.id}:done`)
    await bot.text(A, 'Закончил. 15 минут на презентацию, 5 минут на письма, остальное на отчёт')
    expect(bot.textsTo(A).some((text) => text.includes('Распределил 40 минут'))).toBe(true)
    expect(await prisma.taskTimeAllocation.findMany({
      where: { sessionId: session.id },
      orderBy: { seconds: 'asc' },
      select: { seconds: true },
    })).toEqual([{ seconds: 300 }, { seconds: 900 }, { seconds: 1200 }])
    expect(await prisma.focusSession.findUniqueOrThrow({ where: { id: session.id } })).toMatchObject({ counted: true })
    expect(await prisma.pointsEntry.aggregate({ where: { refKey: `session:${session.id}` }, _sum: { amount: true } })).toMatchObject({
      _sum: { amount: 10 },
    })

    await bot.text(A, '/today')
    const summary = bot.textsTo(A).find((text) => text.includes('По задачам:'))
    expect(summary).toContain('• Подготовить презентацию — 15 минут')
    expect(summary).toContain('• Ответить на письма — 5 минут')
    expect(summary).toContain('• Собрать отчёт — 20 минут')
  })

  it('не применяет постфактум-разметку больше фактического времени', async () => {
    const allocationLlm: LlmProvider = {
      enabled: true,
      model: 'test-model',
      async complete() {
        return {
          text: JSON.stringify({
            progress: 'moved',
            next_step: null,
            allocations: [{ task: 't1', title: 'Подготовить презентацию', minutes: 50, remainder: false }],
          }),
          usage: null,
        }
      },
    }
    const bot = makeBot({ llm: allocationLlm })
    await bot.onboard(A)
    const user = await prisma.user.findUniqueOrThrow({ where: { tgId: BigInt(A) } })
    await prisma.task.create({ data: { userId: user.id, title: 'Подготовить презентацию' } })

    await bot.text(A, 'Начать сессию')
    const session = await prisma.focusSession.findFirstOrThrow({ where: { userId: user.id, state: 'running' } })
    bot.advance(40)
    await runOutboxOnce(bot.ctx)
    await bot.press(A, `out:${session.id}:done`)
    await bot.text(A, '50 минут на презентацию')

    expect(bot.textsTo(A)).toContain('Не смог надёжно распределить время: указанные минуты превышают фактическую работу. Сам отчёт сохранил без изменений.')
    expect(await prisma.taskTimeAllocation.count({ where: { sessionId: session.id } })).toBe(0)
    expect(await prisma.focusSession.findUniqueOrThrow({ where: { id: session.id } })).toMatchObject({ counted: true })
  })

  it('суммирует рабочие периоды одной сессии и не относит отдых ко времени задачи', async () => {
    const bot = makeBot()
    await bot.onboard(A)
    const user = await prisma.user.findUniqueOrThrow({ where: { tgId: BigInt(A) } })
    const task = await prisma.task.create({ data: { userId: user.id, title: 'Подготовить релиз' } })

    await bot.press(A, `task:${task.id}:start`)
    bot.advance(10)
    await bot.text(A, 'Перерыв')
    bot.advance(20)
    await bot.text(A, 'Вернуться к работе')
    bot.advance(15)
    await bot.text(A, '/today')

    const summary = bot.textsTo(A).find((text) => text.includes('По задачам:'))
    expect(summary).toContain('• Подготовить релиз — 25 минут')
    expect(summary).not.toContain('45 минут')
  })

  it('подтверждение времени встречи не отменяет такую же встречу по умолчанию', async () => {
    const bot = makeBot({ now: new Date('2026-09-24T16:51:00Z') })
    await bot.onboard(A, '19:51')
    const user = await prisma.user.findUniqueOrThrow({ where: { tgId: BigInt(A) } })
    await prisma.user.update({ where: { id: user.id }, data: { morningTime: '08:30' } })

    await bot.text(A, '/today')
    const before = await prisma.outboxMessage.findFirstOrThrow({ where: { userId: user.id, kind: 'meeting' } })
    expect(before).toMatchObject({ status: 'pending', payload: { defaulted: true, morning: true } })

    await bot.press(A, 'meet::morning')

    const meetings = await prisma.outboxMessage.findMany({ where: { userId: user.id, kind: 'meeting' } })
    expect(meetings).toHaveLength(1)
    expect(meetings[0]).toMatchObject({ status: 'pending', payload: { defaulted: false, morning: true } })
    expect(meetings[0]?.sendAfter).toEqual(before.sendAfter)
  })

  it('выбор другого времени отменяет прежнюю встречу и оставляет одну активную', async () => {
    const bot = makeBot({ now: new Date('2026-09-24T16:51:00Z') })
    await bot.onboard(A, '19:51')
    const user = await prisma.user.findUniqueOrThrow({ where: { tgId: BigInt(A) } })
    await prisma.user.update({ where: { id: user.id }, data: { morningTime: '08:30' } })

    await bot.text(A, '/today')
    await bot.press(A, 'meet::custom')
    await bot.text(A, '09:00')

    const meetings = await prisma.outboxMessage.findMany({ where: { userId: user.id, kind: 'meeting' }, orderBy: { sendAfter: 'asc' } })
    expect(meetings.map((m) => m.status)).toEqual(['canceled', 'pending'])
    expect(meetings[1]?.payload).toEqual({ defaulted: false, morning: false })
  })

  it('отключение пингов отменяет уже запланированную проверку', async () => {
    const bot = makeBot()
    await bot.onboard(A)
    await bot.text(A, 'набросать план главы')
    await bot.press(A, bot.lastButton(A, 'len:', ':ok'))

    const user = await prisma.user.findUniqueOrThrow({ where: { tgId: BigInt(A) } })
    const session = await prisma.focusSession.findFirstOrThrow({ where: { userId: user.id, state: 'running' } })
    expect(await prisma.outboxMessage.findFirstOrThrow({ where: { idempotencyKey: `ping:${session.id}:1` } })).toMatchObject({
      status: 'pending',
    })

    await bot.text(A, '/settings')
    await bot.press(A, bot.lastButton(A, 'set:', ':pings'))

    expect(await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).toMatchObject({ pingsEnabled: false })
    expect(await prisma.outboxMessage.findFirstOrThrow({ where: { idempotencyKey: `ping:${session.id}:1` } })).toMatchObject({
      status: 'canceled',
    })

    bot.advance(20)
    await runOutboxOnce(bot.ctx)
    expect(bot.textsTo(A)).not.toContain('На месте?')
  })

  it('трижды досидел и сразу продолжал — бот один раз предлагает длинные блоки', async () => {
    const bot = makeBot()
    await bot.onboard(A)
    const user = await prisma.user.findUniqueOrThrow({ where: { tgId: BigInt(A) } })
    for (let i = 0; i < 4; i++) {
      await bot.text(A, `шаг ${i}`)
      await bot.press(A, bot.lastButton(A, 'len:', ':ok'))
      const s = await prisma.focusSession.findFirstOrThrow({ where: { userId: user.id, state: 'running' } })
      bot.advance(40)
      await bot.press(A, `out:${s.id}:done`)
      await bot.press(A, `skiprep:${s.id}:`)
      await bot.press(A, `rest:${s.id}:continue`)
    }
    const suggestions = bot.textsTo(A).filter((t) => t.includes('длинные блоки'))
    expect(suggestions).toHaveLength(1)
    // И предложение длины выросло по правилу «трижды просил ещё».
    expect(bot.textsTo(A).filter((t) => t.startsWith('Давай')).at(-1)).toBe('Давай 50 минут работы, потом 10 отдыха.')
  })
})
