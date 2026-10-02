import { beforeEach, describe, expect, it } from 'vitest'
import type { LlmProvider } from '../llm/provider.js'
import { makeBot } from '../test/bot.js'
import { hasDb, prisma, resetDb } from '../test/db.js'

const A = 1091

function helperProvider(answer: string): LlmProvider {
  return {
    enabled: true,
    model: 'test-model',
    async complete(req) {
      if (req.system.includes('активной фокус-сессии')) return { text: answer, usage: null }
      if (req.system.includes('сообщение пользователя фокус-боту')) {
        return { text: '{"kind":"session_intent","new_tasks":[],"start_title":null,"complete_title":null}', usage: null }
      }
      return { text: '{"task":null,"title":"Подготовить черновик","scope":"step"}', usage: null }
    },
  }
}

describe.skipIf(!hasDb)('свободный текст во время активной сессии', () => {
  beforeEach(resetDb)

  it('на отвлечение отвечает fallback и предлагает продолжить без изменения сессии', async () => {
    const bot = makeBot()
    await bot.onboard(A)
    await bot.text(A, 'подготовить черновик, 25 минут')
    const before = await prisma.focusSession.findFirstOrThrow({ where: { state: 'running' } })

    await bot.text(A, 'Опять отвлёкся на уведомления')

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
    await bot.onboard(A)
    await bot.text(A, 'подготовить черновик, 25 минут')
    const running = await prisma.focusSession.findFirstOrThrow({ where: { state: 'running' } })

    await bot.text(A, 'Хожу по кругу и не вижу следующего хода')

    expect(bot.lastText(A)).toBe('Сделай шаг меньше: набросай три пункта без редактуры.')
    expect(bot.lastButton(A, 'help:', ':step')).toBe(`help:${running.id}:step`)
    await bot.press(A, `help:${running.id}:step`)
    expect(await prisma.user.findUniqueOrThrow({ where: { tgId: BigInt(A) } })).toMatchObject({ pendingInput: `running_work:${running.id}` })
    expect(bot.lastText(A)).toContain('новую формулировку')
    expect(await prisma.componentCall.findFirstOrThrow({ where: { name: 'session_help' } })).toMatchObject({
      sessionId: running.id,
      model: 'test-model',
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
    await bot.onboard(A)
    await bot.text(A, 'подготовить черновик, 25 минут')
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
          if (req.system.includes('активной фокус-сессии')) {
            seen.push(JSON.parse(req.input) as Record<string, unknown>)
            return { text: '{"kind":"question","reply":"Начни с одного предложения.","action":"continue"}', usage: null }
          }
          if (req.system.includes('сообщение пользователя фокус-боту')) {
            return { text: '{"kind":"session_intent","new_tasks":[],"start_title":null,"complete_title":null}', usage: null }
          }
          return { text: '{"task":null,"title":"Подготовить черновик","scope":"step"}', usage: null }
        },
      },
    })
    await bot.onboard(A)
    await bot.text(A, 'первая задача, 25 минут')
    await bot.text(A, 'Как начать первую?')
    await bot.text(A, '/stop')
    await bot.text(A, 'вторая задача, 25 минут')
    await bot.text(A, 'Как начать вторую?')

    expect(seen).toHaveLength(2)
    expect(seen[0]?.recent_context).toEqual([
      expect.objectContaining({ role: 'assistant', text: expect.stringContaining('началась') }),
    ])
    expect(seen[1]?.recent_context).toEqual([
      expect.objectContaining({ role: 'assistant', text: expect.stringContaining('началась') }),
    ])
    expect(JSON.stringify(seen[1]?.recent_context)).not.toContain('первую')
  })

  it('на досрочное завершение только открывает штатный выбор исхода', async () => {
    const bot = makeBot({
      llm: helperProvider('{"kind":"finished_early","reply":"Готово раньше — зафиксируй результат.","action":"finish"}'),
    })
    await bot.onboard(A)
    await bot.text(A, 'подготовить черновик, 25 минут')
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
    await bot.onboard(A)
    await bot.text(A, 'подготовить черновик, 25 минут')

    await bot.text(A, 'Добавь задачу позвонить поставщику')

    expect(await prisma.task.findFirst({ where: { title: 'Позвонить поставщику' } })).not.toBeNull()
    expect(bot.lastText(A)).toContain('Позвонить поставщику')
  })

  it('сохраняет название новой задачи до подтверждения и привязывает её без перезапуска таймера', async () => {
    const bot = makeBot({
      llm: helperProvider('{"kind":"question","reply":"Уточни, это новая задача или выбираешь из списка?","action":"continue"}'),
    })
    await bot.onboard(A)
    await bot.text(A, 'Начать сессию')
    const before = await prisma.focusSession.findFirstOrThrow({ where: { state: 'running' } })

    await bot.text(A, 'Интервью с Денисом')

    expect(bot.lastText(A)).toContain('«Интервью с Денисом»')
    expect(bot.lastText(A)).toContain('новая задача')
    expect(bot.lastButton(A, 'rtask:', ':new')).toBe(`rtask:${before.id}:new`)

    await bot.text(A, 'Новая')

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
    await bot.onboard(A)
    await bot.text(A, 'Начать сессию')

    await bot.text(A, 'Интервью с Денисом')
    await bot.text(A, 'Идиот!')

    expect(bot.lastText(A)).toContain('«Интервью с Денисом»')
    expect(bot.lastText(A)).toContain('новая задача')
    await bot.text(A, 'Новая')
    expect(await prisma.task.findFirst({ where: { title: 'Интервью с Денисом', status: 'active' } })).not.toBeNull()
    expect(await prisma.task.findFirst({ where: { title: 'Идиот!', status: 'active' } })).toBeNull()
  })

  it('отменяет подтверждение кнопкой и не создаёт задачу', async () => {
    const bot = makeBot({ llm: helperProvider('{"kind":"other","reply":null,"action":null}') })
    await bot.onboard(A)
    await bot.text(A, 'Начать сессию')
    const running = await prisma.focusSession.findFirstOrThrow({ where: { state: 'running' } })

    await bot.text(A, 'Интервью с Денисом')
    await bot.press(A, `rtask:${running.id}:cancel`)

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
    await bot.onboard(A)
    const user = await prisma.user.findUniqueOrThrow({ where: { tgId: BigInt(A) } })
    const task = await prisma.task.create({ data: { userId: user.id, title: 'Существующая задача' } })
    await bot.text(A, 'Начать сессию')
    const running = await prisma.focusSession.findFirstOrThrow({ where: { state: 'running' } })

    await bot.text(A, 'Интервью с Денисом')
    await bot.press(A, `rtask:${running.id}:existing`)

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

  it('другая команда снимает ожидание и удаляет сохранённый кандидат', async () => {
    const bot = makeBot({ llm: helperProvider('{"kind":"other","reply":null,"action":null}') })
    await bot.onboard(A)
    await bot.text(A, 'Начать сессию')
    const running = await prisma.focusSession.findFirstOrThrow({ where: { state: 'running' } })

    await bot.text(A, 'Интервью с Денисом')
    await bot.text(A, 'Мои задачи')

    expect(await prisma.focusSession.findUniqueOrThrow({ where: { id: running.id } })).toMatchObject({
      state: 'running',
      taskId: null,
      pendingTaskTitle: null,
    })
    expect(await prisma.user.findUniqueOrThrow({ where: { tgId: BigInt(A) } })).toMatchObject({ pendingInput: 'none' })
  })
})
