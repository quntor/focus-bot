import { beforeEach, describe, expect, it } from 'vitest'
import type { LlmProvider } from '../llm/provider.js'
import { releasePending } from '../tg/webhook.js'
import { makeBot } from '../test/bot.js'
import { hasDb, prisma, resetDb } from '../test/db.js'

const A = 1091

function helperProvider(answer: string): LlmProvider {
  return {
    enabled: true,
    model: 'test-model',
    async complete(req) {
      const text = JSON.parse(req.input).text
      return { text: JSON.stringify({ route: 'session_help', text, help: { task_title: null, ...JSON.parse(answer) }, followUp: null }), usage: null }
    },
  }
}

describe.skipIf(!hasDb)('свободный текст во время активной сессии', () => {
  beforeEach(resetDb)

  it('на отвлечение отвечает модель и предлагает продолжить без изменения сессии', async () => {
    const bot = makeBot()
    await bot.setupOnboarded(A)
    await bot.textAs(A, 'подготовить черновик, 25 минут', {"text":"подготовить черновик, 25 минут","route":"new_task","intent":{"task":null,"title":"подготовить черновик","scope":"step"},"minutes":25,"durationSource":"25 минут","followUp":null})
    const before = await prisma.focusSession.findFirstOrThrow({ where: { state: 'running' } })

    await bot.textAs(A, 'Опять отвлёкся на уведомления', { route: 'session_help', text: 'Опять отвлёкся на уведомления', help: { kind: 'distracted', reply: 'Закрой уведомления и вернись к шагу.', action: 'continue', task_title: null }, followUp: null })

    expect(bot.lastText(A)).toContain('вернись')
    expect(bot.lastButton(A, 'help:', ':continue')).toBe(`help:${before.id}:continue`)
    expect(await prisma.focusSession.findUniqueOrThrow({ where: { id: before.id } })).toMatchObject({
      state: 'running',
      intentText: before.intentText,
      plannedEndAt: before.plannedEndAt,
    })
    await bot.press(A, `help:${before.id}:continue`)
    expect(bot.lastText(A)).toContain('Продолжаем')
  })

  it('на застревание предлагает штатную правку текущего шага', async () => {
    const bot = makeBot({
      llm: helperProvider('{"kind":"stuck","reply":"Сделай шаг меньше: набросай три пункта без редактуры.","action":"change_step"}'),
    })
    await bot.setupOnboarded(A)
    await bot.textAs(A, 'подготовить черновик, 25 минут', {"text":"подготовить черновик, 25 минут","route":"new_task","intent":{"task":null,"title":"подготовить черновик","scope":"step"},"minutes":25,"durationSource":"25 минут","followUp":null})
    const running = await prisma.focusSession.findFirstOrThrow({ where: { state: 'running' } })

    await bot.text(A, 'Хожу по кругу и не вижу следующего хода')

    expect(bot.lastText(A)).toBe('Сделай шаг меньше: набросай три пункта без редактуры.')
    expect(bot.lastButton(A, 'help:', ':step')).toBe(`help:${running.id}:step`)
    await bot.press(A, `help:${running.id}:step`)
    expect(await prisma.user.findUniqueOrThrow({ where: { tgId: BigInt(A) } })).toMatchObject({ pendingInput: `running_work:${running.id}` })
    expect(bot.lastText(A)).toContain('новую формулировку')
    expect(await prisma.componentCall.findFirstOrThrow({ where: { name: 'semantic_router' } })).toMatchObject({
      sessionId: running.id,
      model: 'explicit-test',
      status: 'ok',
    })
    expect(await prisma.event.findFirstOrThrow({ where: { type: 'session_help_requested' } })).toMatchObject({
      sessionId: running.id,
      payload: { kind: 'stuck', action: 'change_step', llm_used: true },
      isUserAction: true,
    })
  })

  it('на вопрос отвечает коротко и оставляет продолжение под контролем человека', async () => {
    const bot = makeBot({
      llm: helperProvider('{"kind":"question","reply":"Сначала набросай главную мысль одним предложением.","action":"continue"}'),
    })
    await bot.setupOnboarded(A)
    await bot.textAs(A, 'подготовить черновик, 25 минут', {"text":"подготовить черновик, 25 минут","route":"new_task","intent":{"task":null,"title":"подготовить черновик","scope":"step"},"minutes":25,"durationSource":"25 минут","followUp":null})
    const running = await prisma.focusSession.findFirstOrThrow({ where: { state: 'running' } })

    await bot.text(A, 'Как лучше начать первый абзац?')

    expect(bot.lastText(A)).toBe('Сначала набросай главную мысль одним предложением.')
    expect(bot.lastButton(A, 'help:', ':continue')).toBe(`help:${running.id}:continue`)
    expect(await prisma.focusSession.findUniqueOrThrow({ where: { id: running.id } })).toMatchObject({ state: 'running' })
  })

  it('даёт модели только недавний контекст текущей сессии и сбрасывает прошлую', async () => {
    const seen: Array<Record<string, unknown>> = []
    const bot = makeBot({
      llm: {
        enabled: true,
        model: 'test-model',
        async complete(req) {
          const input = JSON.parse(req.input)
          seen.push(input)
          return { text: JSON.stringify({ route: 'session_help', text: input.text, help: { kind: 'question', reply: 'Начни с одного предложения.', action: 'continue', task_title: null }, followUp: null }), usage: null }
        },
      },
    })
    await bot.setupOnboarded(A)
    await bot.textAs(A, 'первая задача, 25 минут', { route: 'new_task', text: 'первая задача, 25 минут', intent: { task: null, title: 'первая задача', scope: 'step' }, minutes: 25, durationSource: '25 минут', followUp: null })
    await bot.text(A, 'Как начать первую?')
    await bot.textAs(A, '/stop', {"text":"/stop","route":"control","action":"stop","value":null,"followUp":null})
    await bot.textAs(A, 'вторая задача, 25 минут', { route: 'new_task', text: 'вторая задача, 25 минут', intent: { task: null, title: 'вторая задача', scope: 'step' }, minutes: 25, durationSource: '25 минут', followUp: null })
    await bot.text(A, 'Как начать вторую?')

    expect(seen).toHaveLength(2)
    expect(seen[0]?.recentContext).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'assistant', text: expect.stringContaining('Поехали') }),
    ]))
    expect(seen[1]?.recentContext).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'assistant', text: expect.stringContaining('Поехали') }),
    ]))
    expect(JSON.stringify(seen[1]?.recentContext)).not.toContain('первую')
  })

  it('на досрочное завершение только открывает штатный выбор исхода', async () => {
    const bot = makeBot({
      llm: helperProvider('{"kind":"finished_early","reply":"Готово раньше — зафиксируй результат.","action":"finish"}'),
    })
    await bot.setupOnboarded(A)
    await bot.textAs(A, 'подготовить черновик, 25 минут', {"text":"подготовить черновик, 25 минут","route":"new_task","intent":{"task":null,"title":"подготовить черновик","scope":"step"},"minutes":25,"durationSource":"25 минут","followUp":null})
    const running = await prisma.focusSession.findFirstOrThrow({ where: { state: 'running' } })

    await bot.text(A, 'Уложился раньше, результат уже отправлен')
    await bot.press(A, `help:${running.id}:finish`)

    expect(bot.lastText(A)).toBe('Как прошло?')
    expect(bot.lastButton(A, 'out:', ':done')).toBe(`out:${running.id}:done`)
    expect(await prisma.focusSession.findUniqueOrThrow({ where: { id: running.id } })).toMatchObject({ state: 'running', outcome: null })
    expect(await prisma.pointsEntry.count()).toBe(0)
  })

  it('other не перехватывает существующие команды задачам', async () => {
    const bot = makeBot({
      llm: {
        enabled: true,
        model: 'test-model',
        async complete(req) {
          if (req.system.includes('активной фокус-сессии')) {
            return { text: '{"kind":"other","reply":null,"action":null}', usage: null }
          }
          if (req.system.includes('сообщение пользователя фокус-боту')) {
            const text = JSON.parse(req.input).text as string
            return text.startsWith('Добавь')
              ? { text: '{"kind":"capture","new_tasks":["Позвонить поставщику"],"start_title":null,"complete_title":null}', usage: null }
              : { text: '{"kind":"session_intent","new_tasks":[],"start_title":null,"complete_title":null}', usage: null }
          }
          return { text: '{"task":null,"title":"Подготовить черновик","scope":"step"}', usage: null }
        },
      },
    })
    await bot.setupOnboarded(A)
    await bot.textAs(A, 'подготовить черновик, 25 минут', {"text":"подготовить черновик, 25 минут","route":"new_task","intent":{"task":null,"title":"подготовить черновик","scope":"step"},"minutes":25,"durationSource":"25 минут","followUp":null})

    await bot.textAs(A, 'Добавь задачу позвонить поставщику', { route: 'capture', text: 'Добавь задачу позвонить поставщику', titles: ['Позвонить поставщику'], followUp: null })

    expect(await prisma.task.findFirst({ where: { title: 'Позвонить поставщику' } })).not.toBeNull()
    expect(bot.lastText(A)).toContain('Позвонить поставщику')
  })

  it('сохраняет название новой задачи до подтверждения и привязывает её без перезапуска таймера', async () => {
    const bot = makeBot({
      llm: helperProvider('{"kind":"question","reply":"Уточни, это новая задача или выбираешь из списка?","action":"continue"}'),
    })
    await bot.setupOnboarded(A)
    await bot.textAs(A, 'Начать сессию', {"text":"Начать сессию","route":"control","action":"focus","value":null,"followUp":null})
    const before = await prisma.focusSession.findFirstOrThrow({ where: { state: 'running' } })

    await bot.textAs(A, 'Интервью с Денисом', {"text":"Интервью с Денисом","route":"new_task","intent":{"task":null,"title":"Интервью с Денисом","scope":"step"},"minutes":null,"durationSource":null,"followUp":null})

    expect(bot.lastText(A)).toContain('«Интервью с Денисом»')
    expect(bot.lastText(A)).toContain('новая задача')
    expect(bot.lastButton(A, `rtask:${before.id}:new_`)).toMatch(/:new_[0-9a-f]{8}$/)

    await bot.textAs(A, 'Новая', {"text":"Новая","route":"answer_pending","answer":{"kind":"choice","value":"new"},"followUp":null})

    const task = await prisma.task.findFirstOrThrow({ where: { title: 'Интервью с Денисом' } })
    expect(await prisma.focusSession.findUniqueOrThrow({ where: { id: before.id } })).toMatchObject({
      state: 'running',
      taskId: task.id,
      intentText: task.title,
      startedAt: before.startedAt,
      plannedEndAt: before.plannedEndAt,
    })
    expect(await prisma.user.findUniqueOrThrow({ where: { tgId: BigInt(A) } })).toMatchObject({ pendingInput: 'none' })
  })

  it('не теряет сохранённое название после непонятного ответа', async () => {
    const bot = makeBot({
      llm: helperProvider('{"kind":"question","reply":"Уточни, это новая задача или выбираешь из списка?","action":"continue"}'),
    })
    await bot.setupOnboarded(A)
    await bot.textAs(A, 'Начать сессию', {"text":"Начать сессию","route":"control","action":"focus","value":null,"followUp":null})

    await bot.textAs(A, 'Интервью с Денисом', {"text":"Интервью с Денисом","route":"new_task","intent":{"task":null,"title":"Интервью с Денисом","scope":"step"},"minutes":null,"durationSource":null,"followUp":null})
    await bot.textAs(A, 'Идиот!', {"text":"Идиот!","route":"feedback","followUp":null})

    expect((await prisma.focusSession.findFirstOrThrow({ where: { state: 'running' } })).pendingTaskTitle).toBe('Интервью с Денисом')
    await bot.textAs(A, 'Новая', {"text":"Новая","route":"answer_pending","answer":{"kind":"choice","value":"new"},"followUp":null})
    expect(await prisma.task.findFirst({ where: { title: 'Интервью с Денисом', status: 'active' } })).not.toBeNull()
    expect(await prisma.task.findFirst({ where: { title: 'Идиот!', status: 'active' } })).toBeNull()
  })

  it('отменяет подтверждение кнопкой и не создаёт задачу', async () => {
    const bot = makeBot({ llm: helperProvider('{"kind":"other","reply":null,"action":null}') })
    await bot.setupOnboarded(A)
    await bot.textAs(A, 'Начать сессию', {"text":"Начать сессию","route":"control","action":"focus","value":null,"followUp":null})
    const running = await prisma.focusSession.findFirstOrThrow({ where: { state: 'running' } })

    await bot.textAs(A, 'Интервью с Денисом', {"text":"Интервью с Денисом","route":"new_task","intent":{"task":null,"title":"Интервью с Денисом","scope":"step"},"minutes":null,"durationSource":null,"followUp":null})
    await bot.press(A, bot.lastButton(A, `rtask:${running.id}:cancel_`))

    expect(await prisma.task.findFirst({ where: { title: 'Интервью с Денисом' } })).toBeNull()
    expect(await prisma.focusSession.findUniqueOrThrow({ where: { id: running.id } })).toMatchObject({
      state: 'running',
      taskId: null,
      pendingTaskTitle: null,
    })
    expect(await prisma.user.findUniqueOrThrow({ where: { tgId: BigInt(A) } })).toMatchObject({ pendingInput: 'none' })
  })

  it('по кнопке «Из списка» очищает кандидата и показывает существующие задачи', async () => {
    const bot = makeBot({ llm: helperProvider('{"kind":"other","reply":null,"action":null}') })
    await bot.setupOnboarded(A)
    const user = await prisma.user.findUniqueOrThrow({ where: { tgId: BigInt(A) } })
    const task = await prisma.task.create({ data: { userId: user.id, title: 'Существующая задача' } })
    await bot.textAs(A, 'Начать сессию', {"text":"Начать сессию","route":"control","action":"focus","value":null,"followUp":null})
    const running = await prisma.focusSession.findFirstOrThrow({ where: { state: 'running' } })

    await bot.textAs(A, 'Интервью с Денисом', {"text":"Интервью с Денисом","route":"new_task","intent":{"task":null,"title":"Интервью с Денисом","scope":"step"},"minutes":null,"durationSource":null,"followUp":null})
    await bot.press(A, bot.lastButton(A, `rtask:${running.id}:list_`))

    expect(bot.lastText(A)).toContain('Существующая задача')
    expect(await prisma.focusSession.findUniqueOrThrow({ where: { id: running.id } })).toMatchObject({
      state: 'running',
      taskId: null,
      pendingTaskTitle: null,
    })
    expect(await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).toMatchObject({ pendingInput: 'none' })

    await bot.press(A, `task:${task.id}:start`)

    expect(await prisma.focusSession.findUniqueOrThrow({ where: { id: running.id } })).toMatchObject({
      state: 'running',
      taskId: task.id,
      intentText: task.title,
      startedAt: running.startedAt,
      plannedEndAt: running.plannedEndAt,
    })
  })

  it('просмотр задач сохраняет ожидание и кандидат', async () => {
    const bot = makeBot({ llm: helperProvider('{"kind":"other","reply":null,"action":null}') })
    await bot.setupOnboarded(A)
    await bot.textAs(A, 'Начать сессию', {"text":"Начать сессию","route":"control","action":"focus","value":null,"followUp":null})
    const running = await prisma.focusSession.findFirstOrThrow({ where: { state: 'running' } })

    await bot.textAs(A, 'Интервью с Денисом', {"text":"Интервью с Денисом","route":"new_task","intent":{"task":null,"title":"Интервью с Денисом","scope":"step"},"minutes":null,"durationSource":null,"followUp":null})
    await bot.textAs(A, 'Мои задачи', {"text":"Мои задачи","route":"control","action":"tasks","value":null,"followUp":null})

    expect(await prisma.focusSession.findUniqueOrThrow({ where: { id: running.id } })).toMatchObject({
      state: 'running',
      taskId: null,
      pendingTaskTitle: 'Интервью с Денисом',
    })
    expect(await prisma.user.findUniqueOrThrow({ where: { tgId: BigInt(A) } })).toMatchObject({ pendingInput: expect.stringMatching(/^running_task_choice:/) })
  })
  it('старая кнопка не подтверждает нового кандидата в той же сессии', async () => {
    const bot = makeBot({ llm: helperProvider('{"kind":"other","reply":null,"action":null}') })
    await bot.setupOnboarded(A)
    await bot.textAs(A, 'Начать сессию', {"text":"Начать сессию","route":"control","action":"focus","value":null,"followUp":null})
    await bot.textAs(A, 'Интервью с Денисом', {"text":"Интервью с Денисом","route":"new_task","intent":{"task":null,"title":"Интервью с Денисом","scope":"step"},"minutes":null,"durationSource":null,"followUp":null})
    const oldButton = bot.buttons(A).find(b => b.data.includes(':new_'))!.data
    await bot.textAs(A, 'Мои задачи', {"text":"Мои задачи","route":"control","action":"tasks","value":null,"followUp":null})
    await bot.textAs(A, 'Подготовить статью', {"text":"Подготовить статью","route":"new_task","intent":{"task":null,"title":"Подготовить статью","scope":"step"},"minutes":null,"durationSource":null,"followUp":null})
    await bot.press(A, oldButton)
    expect(await prisma.task.count()).toBe(0)
    const current = await prisma.focusSession.findFirstOrThrow({ where: { state: 'running' } })
    expect(current).toMatchObject({ taskId: null, pendingTaskTitle: 'Подготовить статью' })
    await bot.textAs(A, 'Новая', {"text":"Новая","route":"answer_pending","answer":{"kind":"choice","value":"new"},"followUp":null})
    expect(await prisma.task.findFirstOrThrow()).toMatchObject({ title: 'Подготовить статью' })
  })

  it('снятие ожидания ждёт блокировку подтверждения до изменения user и session', async () => {
    const bot = makeBot({ llm: helperProvider('{"kind":"other","reply":null,"action":null}') })
    await bot.setupOnboarded(A)
    await bot.textAs(A, 'Начать сессию', {"text":"Начать сессию","route":"control","action":"focus","value":null,"followUp":null})
    await bot.textAs(A, 'Интервью с Денисом', {"text":"Интервью с Денисом","route":"new_task","intent":{"task":null,"title":"Интервью с Денисом","scope":"step"},"minutes":null,"durationSource":null,"followUp":null})
    const user = await prisma.user.findUniqueOrThrow({ where: { tgId: BigInt(A) } })
    let unlock!: () => void
    let ready!: () => void
    const gate = new Promise<void>(resolve => { unlock = resolve })
    const acquired = new Promise<void>(resolve => { ready = resolve })
    const holder = prisma.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${user.id}))`
      ready()
      await gate
    })
    await acquired
    const release = releasePending(bot.ctx, user)
    try {
      let waiting = false
      for (let i = 0; i < 30; i++) {
        const rows = await prisma.$queryRaw<{ waiting: boolean }[]>`
          SELECT EXISTS (SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND NOT granted) AS waiting`
        if (rows[0]?.waiting) { waiting = true; break }
        await new Promise(resolve => setTimeout(resolve, 20))
      }
      expect(waiting).toBe(true)
      expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).pendingInput).toBe(user.pendingInput)
    } finally {
      unlock()
      await holder
      await release
    }
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).pendingInput).toBe('none')
    expect((await prisma.focusSession.findFirstOrThrow({ where: { userId: user.id } })).pendingTaskTitle).toBeNull()
  })

})
