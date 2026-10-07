import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LlmProvider, LlmRequest } from '../llm/provider.js'
import { makeBot } from '../test/bot.js'
import { handleUpdate } from '../tg/webhook.js'
import { latestInputId } from './conversation-context.js'
import { hasDb, prisma, resetDb } from '../test/db.js'
import { deliverReminder } from '../reminders/delivery.js'
import { runOutboxOnce } from '../outbox/worker.js'

const A = 50201
const B = 50202
const newAction = (text: string, title = 'Фокус-бот') => ({ route: 'new_task', text, intent: { task: null, title, scope: 'step' }, followUp: null })
const reportAction = (text: string, followUp: unknown = null) => ({ route: 'report', text, report: { route: 'report', progress: 'moved', next_step: null, continue_now: false, continue_minutes: null, allocations: [] }, followUp })
function provider(value: unknown | ((req: LlmRequest) => Promise<unknown>)): LlmProvider {
  return { enabled: true, model: 'test', complete: vi.fn(async (req) => ({ text: JSON.stringify(typeof value === 'function' ? await value(req) : value), usage: null })) }
}
async function ready(value: unknown | ((req: LlmRequest) => Promise<unknown>)) {
  const llm = provider(value)
  const bot = makeBot({ llm })
  await bot.setupOnboarded(A)
  bot.ctx.semanticRouterEnabled = true
  const user = await prisma.user.findUniqueOrThrow({ where: { tgId: BigInt(A) } })
  await prisma.focusSession.deleteMany({ where: { userId: user.id } })
  return { bot, llm, user }
}
async function past(userId: string, now: Date) {
  const task = await prisma.task.create({ data: { userId, title: 'Отчёт' } })
  const old = await prisma.focusSession.create({ data: { userId, state: 'finished', taskId: task.id, intentText: task.title, outcome: 'done', startedAt: new Date(now.getTime() - 25 * 60_000), finishedAt: now, plannedMinutes: 25, counted: true } })
  await prisma.user.update({ where: { id: userId }, data: { pendingInput: 'report_text' } })
  return { old, task }
}

describe.skipIf(!hasDb)('semantic routing: реальные регрессии и отсутствие смешанных записей', () => {
  beforeEach(resetDb)
  it.each([
    ['running', 'еще 15 минут поработаю', 15],
    ['running', 'продолжу работать', 40],
    ['paused', 'еще 15 минут поработаю', 15],
  ] as const)('продолжает %s после вопроса, сохраняя задачу и заданный интервал (%s)', async (state, text, minutes) => {
    const { bot, llm, user } = await ready(async (req: LlmRequest) => {
      if (!req.system.includes('семантический маршрутизатор')) return { text: 'Продолжишь или передохнёшь?', taskId: null }
      const input = JSON.parse(req.input)
      return { route: input.allowedRoutes.includes('continue_same') ? 'continue_same' : 'unclear', text, minutes: text === 'еще 15 минут поработаю' ? 15 : null, durationSource: text === 'еще 15 минут поработаю' ? '15 минут' : null, followUp: null }
    })
    bot.ctx.remindersEnabled = true
    const now = bot.ctx.now()
    const task = await prisma.task.create({ data: { userId: user.id, title: 'Фокус-бот' } })
    await prisma.user.update({ where: { id: user.id }, data: { reminderPolicy: 1, pendingInput: 'none' } })
    const startedAt = new Date(now.getTime() - 40 * 60_000)
    const active = await prisma.focusSession.create({ data: { userId: user.id, taskId: task.id, intentText: task.title, state, reminderPolicy: 1, startedAt, plannedEndAt: now, plannedMinutes: 40, pausedAt: state === 'paused' ? now : null } })
    await prisma.workPeriod.create({ data: { sessionId: active.id, startedAt, endedAt: state === 'paused' ? now : null } })
    const chain = await prisma.reminderChain.create({ data: { userId: user.id, sessionId: active.id, kind: state === 'running' ? 'work' : 'break', phaseStartedAt: startedAt, firstDueAt: now, nextDueAt: now, intervalMinutes: 40 } })
    if (state === 'running') {
      const message = await prisma.outboxMessage.create({ data: { userId: user.id, kind: 'reminder', chainId: chain.id, chainRevision: 1, ordinal: 0, idempotencyKey: `reminder:${chain.id}:1:0`, sendAfter: now, status: 'sending', attempts: 1, lockedUntil: new Date(now.getTime() + 60_000) } })
      await deliverReminder(bot.ctx, message)
    }
    await bot.text(A, text)
    const routed = await prisma.event.findFirstOrThrow({ where: { type: 'semantic_routed' } })
    expect(routed.payload).toMatchObject({ route: 'continue_same' })
    expect(await prisma.focusSession.findUniqueOrThrow({ where: { id: active.id } })).toMatchObject({ state: 'running', taskId: task.id, startedAt, plannedEndAt: new Date(now.getTime() + minutes * 60_000), reportText: null, outcome: null })
    expect(await prisma.task.count()).toBe(1)
    expect(await prisma.focusSession.count()).toBe(1)
    expect(await prisma.reminderChain.findFirstOrThrow({ where: { userId: user.id, status: 'active' } })).toMatchObject({ kind: 'work', nextDueAt: new Date(now.getTime() + minutes * 60_000), intervalMinutes: minutes })
    expect(bot.textsTo(A)).not.toContain('Это отчёт о результате или новая задача?')
    const request = vi.mocked(llm.complete).mock.calls.find(([req]) => req.system.includes('семантический маршрутизатор'))![0]
    if (state === 'running') expect(JSON.parse(request.input).recentContext).toContainEqual({ role: 'assistant', text: 'Продолжишь или передохнёшь?' })
    const sent = bot.tg.sent.length
    bot.advance(minutes - 1)
    await runOutboxOnce(bot.ctx)
    expect(bot.tg.sent).toHaveLength(sent)
    bot.advance(1)
    await runOutboxOnce(bot.ctx)
    expect(bot.lastText(A)).toBe('Продолжишь или передохнёшь?')
    expect(bot.tg.sent).toHaveLength(sent + 1)
    expect(await prisma.focusSession.findUniqueOrThrow({ where: { id: active.id } })).toMatchObject({ state: 'running', taskId: task.id, outcome: null })
  })
  it('legacy: ещё 15 минут — от момента ответа, не от начала сорокаминутной работы', async () => {
    const text = 'еще 15 минут поработаю'
    const { bot, user } = await ready({ route: 'continue_same', text, minutes: 15, durationSource: '15 минут', followUp: null })
    const now = bot.ctx.now()
    const active = await prisma.focusSession.create({ data: { userId: user.id, state: 'running', startedAt: new Date(now.getTime() - 40 * 60_000), plannedMinutes: 40, plannedEndAt: now } })
    await prisma.user.update({ where: { id: user.id }, data: { pendingInput: `session_end:${active.id}` } })
    await bot.text(A, text)
    const next = new Date(now.getTime() + 15 * 60_000)
    expect(await prisma.focusSession.findUniqueOrThrow({ where: { id: active.id } })).toMatchObject({ state: 'running', plannedEndAt: next, reportText: null })
    expect(await prisma.outboxMessage.findFirstOrThrow({ where: { userId: user.id, kind: 'session_end', status: 'pending' } })).toMatchObject({ sendAfter: next })
    expect(await prisma.task.count()).toBe(0)
  })
  it('«Начинаю делать фокус-бот.» при report pending — новая работа, не отчёт', async () => {
    const text = 'Начинаю делать фокус-бот.'
    const { bot, llm, user } = await ready(newAction(text))
    const { old } = await past(user.id, bot.ctx.now())
    await bot.text(A, text)
    expect(await prisma.focusSession.findUniqueOrThrow({ where: { id: old.id } })).toMatchObject({ reportText: null, progress: null, outcome: 'done' })
    expect(await prisma.focusSession.findFirstOrThrow({ where: { state: 'collecting_intent' } })).toMatchObject({ intentText: 'Фокус-бот' })
    expect(bot.lastButton(A, 'report:')).toBe(`report:${old.id}:`)
    expect(llm.complete).toHaveBeenCalledTimes(1)
    expect(await prisma.componentCall.findMany()).toMatchObject([{ name: 'semantic_router', status: 'ok' }])
    expect((await prisma.event.findFirstOrThrow({ where: { type: 'semantic_routed' } })).payload).toEqual({ route: 'new_task', pending: 'report_text', intercepted: true })
  })
  it('обычный отчёт сохраняется без повторной модели и исход не меняется', async () => {
    const text = 'Доделал отчёт.'
    const { bot, llm, user } = await ready(reportAction(text))
    const { old } = await past(user.id, bot.ctx.now())
    await bot.text(A, text)
    expect(await prisma.focusSession.findUniqueOrThrow({ where: { id: old.id } })).toMatchObject({ reportText: text, progress: 'moved', outcome: 'done' })
    expect(llm.complete).toHaveBeenCalledTimes(1)
  })
  it('составная фраза сохраняет только первый отчёт; второе — одна кнопка, replay не пишет', async () => {
    const text = 'доделал отчёт, теперь письма'
    const { bot, llm, user } = await ready(reportAction('доделал отчёт', { route: 'new_task', text: 'письма', intent: { task: null, title: 'письма', scope: 'step' }, minutes: null, durationSource: null }))
    const { old } = await past(user.id, bot.ctx.now())
    await bot.text(A, text)
    expect(await prisma.focusSession.findUniqueOrThrow({ where: { id: old.id } })).toMatchObject({ reportText: 'доделал отчёт', outcome: 'done' })
    expect(await prisma.task.findMany({ where: { title: 'письма' } })).toHaveLength(0)
    expect(await prisma.focusSession.count({ where: { state: { in: ['running', 'collecting_intent'] } } })).toBe(0)
    const button = bot.lastButton(A, 'sroute:', ':next')
    expect(bot.tg.sent.at(-1)?.keyboard?.flat()).toHaveLength(1)
    expect(button).not.toContain('письма')
    await bot.press(A, button)
    expect(await prisma.focusSession.findFirstOrThrow({ where: { state: 'collecting_intent' } })).toMatchObject({ intentText: 'письма' })
    await bot.press(A, button)
    expect(await prisma.focusSession.count({ where: { state: 'collecting_intent' } })).toBe(1)
    expect(llm.complete).toHaveBeenCalledTimes(1)
  })
  it('«продолжаю» после вопроса о продолжении сохраняет taskId и названные минуты', async () => {
    const { bot, llm, user } = await ready({ route: 'continue_same', text: 'продолжаю', followUp: null })
    const { old, task } = await past(user.id, bot.ctx.now())
    await prisma.focusSession.update({ where: { id: old.id }, data: { progress: 'moved', reportText: 'нужно ещё 15 минут', continueSuggested: true, continueMinutes: 15 } })
    await prisma.user.update({ where: { id: user.id }, data: { pendingInput: 'none' } })
    await bot.text(A, 'продолжаю')
    expect(await prisma.focusSession.findFirstOrThrow({ where: { state: 'running' } })).toMatchObject({ taskId: task.id, plannedMinutes: 15, minutesSource: 'user' })
    expect(await prisma.task.count()).toBe(1)
    expect(llm.complete).toHaveBeenCalledTimes(1)
  })
  it('unclear даёт ровно два выбора, без записи; чужой выбор не потребляет владельца', async () => {
    const { bot, user } = await ready({ route: 'unclear', text: 'отчёт', followUp: null })
    const { old } = await past(user.id, bot.ctx.now())
    await bot.text(A, 'отчёт')
    const keyboard = bot.tg.sent.at(-1)?.keyboard?.flat() ?? []
    expect(keyboard).toHaveLength(2)
    expect(await prisma.focusSession.findUniqueOrThrow({ where: { id: old.id } })).toMatchObject({ reportText: null, progress: null })
    bot.ctx.semanticRouterEnabled = false
    await bot.setupOnboarded(B)
    await prisma.focusSession.deleteMany({ where: { user: { tgId: BigInt(B) } } })
    bot.ctx.semanticRouterEnabled = true
    const button = bot.lastButton(A, 'sroute:', ':new')
    await bot.press(B, button)
    expect(await prisma.focusSession.count({ where: { state: 'collecting_intent' } })).toBe(0)
    await bot.press(A, button)
    expect(await prisma.focusSession.count({ where: { state: 'collecting_intent' } })).toBe(0)
    expect(bot.lastText(A)).toContain('какую работу')
  })
  it.each(['pending', 'session', 'task'])('изменившийся %s во время модели отбрасывает ответ', async (kind) => {
    let change!: () => Promise<unknown>
    const text = 'Начинаю делать фокус-бот.'
    const { bot, user } = await ready(async () => { await change(); return newAction(text) })
    const { old, task } = await past(user.id, bot.ctx.now())
    change = kind === 'pending' ? () => prisma.user.update({ where: { id: user.id }, data: { pendingInput: 'profile' } })
      : kind === 'task' ? () => prisma.task.update({ where: { id: task.id }, data: { status: 'done' } })
        : () => prisma.focusSession.create({ data: { userId: user.id, state: 'running', intentText: 'Другой таймер', startedAt: bot.ctx.now() } })
    await bot.text(A, text)
    expect(await prisma.focusSession.findUniqueOrThrow({ where: { id: old.id } })).toMatchObject({ reportText: null })
    expect(await prisma.focusSession.count({ where: { state: 'collecting_intent' } })).toBe(0)
    expect(await prisma.event.count({ where: { type: 'route_stale' } })).toBe(1)
  })
  it('старый флаг false не возвращает text bypass', async () => {
    const { bot, llm } = await ready({ route: 'control', text: '/help', action: 'help', value: null, followUp: null })
    bot.ctx.semanticRouterEnabled = false
    await bot.text(A, '/help')
    expect(llm.complete).toHaveBeenCalledTimes(1)
  })
  it('новая реплика инвалидирует прежнюю кнопку даже без смены DB состояния', async () => {
    const { bot } = await ready({ route: 'unclear', text: 'что дальше', followUp: null })
    await past((await prisma.user.findUniqueOrThrow({ where: { tgId: BigInt(A) } })).id, bot.now())
    await bot.text(A, 'что дальше')
    const oldButton = bot.lastButton(A, 'sroute:', ':new')
    await bot.text(A, 'что дальше')
    await bot.press(A, oldButton)
    expect(await prisma.focusSession.count({ where: { state: { in: ['running', 'collecting_intent'] } } })).toBe(0)
  })
  it('вернуться к отчёту: ownership, window и активная сессия проверяются', async () => {
    const { bot, user } = await ready(newAction('фокус-бот'))
    const { old } = await past(user.id, bot.ctx.now())
    await prisma.user.update({ where: { id: user.id }, data: { pendingInput: 'none' } })
    await bot.press(A, `report:${old.id}`)
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).pendingInput).toBe('report_text')
    await prisma.user.update({ where: { id: user.id }, data: { pendingInput: 'none' } })
    bot.advance(121)
    await bot.press(A, `report:${old.id}`)
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).pendingInput).toBe('none')
  })
  it('session_help завершение требует outcome, не угадывает результат', async () => {
    const text = 'сделал, иду отдыхать'
    const { bot, llm, user } = await ready({ route: 'control', text, action: 'done', value: null, followUp: null })
    const running = await prisma.focusSession.create({ data: { userId: user.id, state: 'running', startedAt: bot.ctx.now(), intentText: 'Отчёт' } })
    await bot.text(A, text)
    expect(await prisma.focusSession.findUniqueOrThrow({ where: { id: running.id } })).toMatchObject({ state: 'running', outcome: null })
    expect(bot.lastButton(A, 'out:', ':done')).toBe(`out:${running.id}:done`)
    expect(llm.complete).toHaveBeenCalledTimes(1)
  })
  it.each(['invalid', 'error'])('provider %s не запускает legacy путь', async (reason) => {
    const text = 'Начинаю делать фокус-бот.'
    const { bot, llm, user } = await ready(async (req: Parameters<LlmProvider['complete']>[0]) => {
      if (req.system.includes('семантический маршрутизатор')) {
        if (reason === 'error') throw new Error('network')
        return { route: 'delete', text, followUp: null }
      }
      if (req.system.includes('сообщение пользователя фокус-боту')) return { kind: 'session_intent', new_tasks: [], start_title: null, complete_title: null }
      return { task: null, title: 'Фокус-бот', scope: 'step' }
    })
    const { old } = await past(user.id, bot.ctx.now())
    await bot.text(A, text)
    expect(await prisma.focusSession.findUniqueOrThrow({ where: { id: old.id } })).toMatchObject({ reportText: null })
    expect(await prisma.focusSession.count({ where: { state: 'collecting_intent' } })).toBe(0)
    expect(bot.lastText(A)).toContain('Ничего не меняю')
    expect(await prisma.event.findFirstOrThrow({ where: { type: 'llm_fallback', payload: { path: ['stage'], equals: 'semantic_router' } } })).toMatchObject({ payload: { stage: 'semantic_router', reason } })
    expect(vi.mocked(llm.complete).mock.calls.filter(([req]) => req.system.includes('семантический маршрутизатор'))).toHaveLength(1)
  })
  it('voice transcript идёт в тот же router; учитывает настоящий STT и routing вызовы', async () => {
    const text = 'Начинаю делать фокус-бот.'
    const { bot, llm, user } = await ready(newAction(text))
    const { old } = await past(user.id, bot.ctx.now())
    bot.ctx.stt = { enabled: true, model: 'stt-test', transcribe: async () => text }
    bot.tg.downloads.set('voice1', new Uint8Array([1, 2, 3]))
    await bot.voice(A, { fileId: 'voice1', duration: 3 })
    expect(await prisma.focusSession.findUniqueOrThrow({ where: { id: old.id } })).toMatchObject({ reportText: null })
    expect(await prisma.focusSession.findFirstOrThrow({ where: { state: 'collecting_intent' } })).toMatchObject({ intentText: 'Фокус-бот' })
    expect(llm.complete).toHaveBeenCalledTimes(1)
    expect((await prisma.componentCall.findMany()).map((call) => call.name).sort()).toEqual(['semantic_router', 'voice_transcription'])
  })
  it('formatted timezone и команда идут через модель, callback — нет', async () => {
    const { bot, llm, user } = await ready(async (req: LlmRequest) => {
      const text = JSON.parse(req.input).text
      return text === '10:00' ? { route: 'answer_pending', text, answer: { kind: 'clock', hour: 10, minute: 0, day: 'next' }, followUp: null }
        : { route: 'control', text, action: 'help', value: null, followUp: null }
    })
    await prisma.user.update({ where: { id: user.id }, data: { pendingInput: 'settings_timezone' } })
    await bot.text(A, '10:00')
    await bot.text(A, '/help')
    await bot.press(A, 'skip::ritual')
    expect(llm.complete).toHaveBeenCalledTimes(2)
  })
  it('answer_pending — конкретный profile handler, а не повторный классификатор', async () => {
    const text = 'Работаю над проектом'
    const { bot, llm, user } = await ready({ route: 'answer_pending', text, answer: { kind: 'text', value: text }, followUp: null })
    await prisma.user.update({ where: { id: user.id }, data: { pendingInput: 'profile' } })
    await bot.text(A, text)
    expect(await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).toMatchObject({ profileText: text, pendingInput: 'none' })
    expect(llm.complete).toHaveBeenCalledTimes(1)
    expect(await prisma.focusSession.count()).toBe(0)
  })
  it('одновременный replay одной compound кнопки не создаёт вторую сессию', async () => {
    const { bot, user } = await ready(reportAction('доделал отчёт', { route: 'new_task', text: 'письма', intent: { task: null, title: 'письма', scope: 'step' }, minutes: null, durationSource: null }))
    await past(user.id, bot.ctx.now())
    await bot.text(A, 'доделал отчёт, теперь письма')
    const button = bot.lastButton(A, 'sroute:', ':next')
    await Promise.all([bot.press(A, button), bot.press(A, button)])
    expect(await prisma.focusSession.count({ where: { state: 'collecting_intent' } })).toBe(1)
  })
  it('новая входящая реплика отменяет старый LLM ответ при неизменном pending', async () => {
    let entered!: () => void
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve })
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let calls = 0
    const { bot, user } = await ready(async () => {
      if (++calls === 1) { entered(); await gate }
      return { route: 'unclear', text: 'что дальше', followUp: null }
    })
    await past(user.id, bot.ctx.now())
    const first = bot.text(A, 'что дальше')
    await enteredPromise
    const firstInput = latestInputId(user.id, bot.ctx.now())!
    const second = bot.text(A, 'что дальше')
    // Let the second update record its input before releasing the first provider.
    await vi.waitFor(() => { expect(latestInputId(user.id, bot.ctx.now())).toBeGreaterThan(firstInput) })
    release()
    await Promise.all([first, second])
    expect(await prisma.event.count({ where: { type: 'route_stale' } })).toBe(1)
    expect(await prisma.focusSession.count({ where: { state: 'collecting_intent' } })).toBe(0)
  })

  it.each(['/guide', '[unsupported]'])('новый %s во время analytics не воскрешает unclear', async (next) => {
    const text = 'Ну вот'
    const { bot, user } = await ready({ route: 'unclear', text, followUp: null })
    await past(user.id, bot.ctx.now())
    const original = prisma.event.create.bind(prisma.event)
    const spy = vi.spyOn(prisma.event, 'create').mockImplementation(((async (args: any) => {
      const result = await original(args)
      if (args.data.type === 'semantic_routed') {
        const previous = latestInputId(user.id, bot.now())
        if (next === '/guide') void bot.text(A, next)
        else void handleUpdate(bot.ctx, { update_id: 99100, message: { message_id: 99100, from: { id: A, is_bot: false, first_name: 'A' }, chat: { id: A, type: 'private' }, date: 1, sticker: {} } })
        await vi.waitFor(() => expect(latestInputId(user.id, bot.now())).not.toBe(previous))
      }
      return result
    }) as unknown) as typeof prisma.event.create)
    try { await bot.text(A, text) } finally { spy.mockRestore() }
    expect(bot.textsTo(A).includes('Это отчёт о результате или новая задача?')).toBe(false)
  })

  it('явный выбор отчёта снимает повторную ambiguity даже у новой работы', async () => {
    const text = 'Начинаю делать фокус-бот.'
    const { bot, user, llm } = await ready(async (req: LlmRequest) => req.system.includes('семантический маршрутизатор')
      ? { route: 'unclear', text, followUp: null }
      : { route: 'unclear', progress: null, next_step: null, continue_now: false, continue_minutes: null, allocations: [] })
    const { old } = await past(user.id, bot.ctx.now())
    await bot.text(A, text)
    await bot.press(A, bot.lastButton(A, 'sroute:', ':report'))
    expect(await prisma.focusSession.findUniqueOrThrow({ where: { id: old.id } })).toMatchObject({ reportText: text, outcome: 'done' })
    expect(await prisma.focusSession.count({ where: { state: 'collecting_intent' } })).toBe(0)
    expect(llm.complete).toHaveBeenCalledTimes(2)
  })

  it('новый /guide во время confirmed report extraction отменяет сохранение', async () => {
    const text = 'Ну вот'
    let entered!: () => void
    let release!: () => void
    const began = new Promise<void>((resolve) => { entered = resolve })
    const gate = new Promise<void>((resolve) => { release = resolve })
    const { bot, user } = await ready(async (req: LlmRequest) => {
      if (req.system.includes('семантический маршрутизатор')) return { route: 'unclear', text, followUp: null }
      entered(); await gate
      return { route: 'report', progress: 'moved', next_step: null, continue_now: false, continue_minutes: null, allocations: [] }
    })
    const { old } = await past(user.id, bot.ctx.now())
    await bot.text(A, text)
    const confirmation = bot.press(A, bot.lastButton(A, 'sroute:', ':report'))
    await began
    const previous = latestInputId(user.id, bot.now())
    const next = bot.text(A, '/guide')
    await vi.waitFor(() => expect(latestInputId(user.id, bot.now())).not.toBe(previous))
    release(); await Promise.all([confirmation, next])
    expect(await prisma.focusSession.findUniqueOrThrow({ where: { id: old.id } })).toMatchObject({ reportText: null, progress: null, outcome: 'done' })
  })

})
