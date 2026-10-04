import { beforeEach, describe, expect, it } from 'vitest'
import type { LlmProvider } from '../llm/provider.js'
import { makeBot } from '../test/bot.js'
import { hasDb, prisma, resetDb } from '../test/db.js'

// Бот ждёт не больше одного ответа. Новое действие — старт сессии, команда,
// кнопка клавиатуры — снимает ожидание, и следующая фраза не уходит в старый
// вопрос. Сценарии — из аудита логики 01.10.
const A = 5101

const user = () => prisma.user.findUniqueOrThrow({ where: { tgId: BigInt(A) } })

describe.skipIf(!hasDb)('ожидание ответа не залипает', () => {
  beforeEach(resetDb)

  it('«Изменить профиль», потом «Начать сессию» — следующая фраза не затирает профиль', async () => {
    const bot = makeBot()
    await bot.onboard(A)
    await bot.press(A, 'prof::edit')
    expect((await user()).pendingInput).toBe('profile')

    await bot.text(A, 'Начать сессию')
    expect((await user()).pendingInput).toBe('none')
    await bot.text(A, 'застрял на отчёте')

    expect((await user()).profileText).toBeNull()
  })

  it('команда снимает ожидание профиля', async () => {
    const bot = makeBot()
    await bot.onboard(A)
    await bot.press(A, 'prof::edit')
    await bot.text(A, '/tasks')
    expect((await user()).pendingInput).toBe('none')
  })

  it('непрописанный отчёт не перехватывает текст новой сессии', async () => {
    const bot = makeBot()
    await bot.onboard(A)
    await bot.text(A, 'глава, 40 минут')
    const first = await prisma.focusSession.findFirstOrThrow({ where: { state: 'running' } })
    bot.advance(40)
    await bot.press(A, `out:${first.id}:done`)
    expect((await user()).pendingInput).toBe('report_text')

    await bot.text(A, 'Начать сессию')
    expect((await user()).pendingInput).toBe('none')
    await bot.text(A, 'отвлёкся')

    expect((await prisma.focusSession.findUniqueOrThrow({ where: { id: first.id } })).reportText).toBeNull()
  })

  it.each([0, 47])('явный старт через %i минут не становится старым отчётом', async (delay) => {
    const bot = makeBot()
    await bot.onboard(A)
    await bot.text(A, 'глава, 40 минут')
    const first = await prisma.focusSession.findFirstOrThrow({ where: { state: 'running' } })
    bot.advance(40)
    await bot.press(A, `out:${first.id}:not_done`)
    bot.advance(delay)

    await bot.text(A, 'Начинаю делать фокус-бот.')

    expect(await prisma.focusSession.findUniqueOrThrow({ where: { id: first.id } })).toMatchObject({ reportText: null, progress: null })
    expect(await prisma.focusSession.count({ where: { state: { in: ['collecting_intent', 'running'] } } })).toBe(1)
    expect((await user()).pendingInput).toBe('none')
    expect(bot.lastText(A)).not.toContain('Записал')
  })

  it('после итога дня бот принимает только явное время, остальное — как обычно', async () => {
    const bot = makeBot()
    await bot.onboard(A)
    await bot.text(A, '/today')
    expect((await user()).pendingInput).toBe('meeting_time_soft')

    await bot.text(A, 'созвон в 9 с Петей')
    expect(bot.lastText(A)).not.toContain('Напиши время')
    expect((await user()).pendingInput).toBe('none')
    expect(await prisma.outboxMessage.findFirst({ where: { kind: 'meeting', status: 'pending', payload: { path: ['morning'], equals: false } } })).toBeNull()
  })

  it('после итога дня «в 9» ставит встречу', async () => {
    const bot = makeBot()
    await bot.onboard(A)
    await bot.text(A, '/today')

    await bot.text(A, 'завтра в 9')

    expect(bot.lastText(A)).toBe('Договорились: завтра в 09:00.')
    expect((await user()).pendingInput).toBe('none')
  })

  it('«Своё время» ждёт время строго', async () => {
    const bot = makeBot()
    await bot.onboard(A)
    await bot.press(A, 'meet::custom')
    await bot.text(A, 'не знаю')
    expect(bot.lastText(A)).toBe('Напиши время, например 18:30.')
    expect((await user()).pendingInput).toBe('meeting_time')
  })

  it('«Добавить задачу», потом старт задачи — фраза в сессии не становится задачей', async () => {
    const bot = makeBot()
    await bot.onboard(A)
    const u = await user()
    const task = await prisma.task.create({ data: { userId: u.id, title: 'Отчёт' } })
    await bot.press(A, 'tasks::add')
    await bot.press(A, `task:${task.id}:start`)

    expect((await user()).pendingInput).toBe('none')
    expect(await prisma.task.count({ where: { userId: u.id } })).toBe(1)
  })

  it('пояс из настроек не перезапускает знакомство', async () => {
    const bot = makeBot()
    await bot.onboard(A)
    await bot.press(A, 'set::timezone')
    await bot.text(A, '12:00')

    expect(bot.lastText(A)).toBe('Понял, у тебя 12:00.')
    expect(await user()).toMatchObject({ timezone: 'Asia/Yekaterinburg', pendingInput: 'none' })
  })

  it('старая кнопка «Пропустить» ритуал не сбивает чужое ожидание', async () => {
    const bot = makeBot()
    await bot.onboard(A)
    await bot.press(A, 'prof::edit')
    await bot.press(A, 'skip::ritual')

    expect(bot.lastText(A)).toBe('Это уже неактуально.')
    expect((await user()).pendingInput).toBe('profile')
  })

  it('на шагах знакомства постоянная клавиатура убирается', async () => {
    const bot = makeBot()
    await bot.text(A, '/start')
    await bot.text(A, '14:00')

    const echo = bot.tg.sent.find((s) => s.text.startsWith('Понял, у тебя'))
    expect(echo?.replyKeyboard).toBe('remove')
  })

  it('голосом можно ответить на «Изменить профиль»', async () => {
    const off: LlmProvider = { enabled: false, model: null, async complete() { throw new Error('не должно вызываться') } }
    const bot = makeBot({ llm: off, stt: { enabled: true, model: 'test-stt', async transcribe() { return 'работаю по утрам' } } })
    bot.tg.downloads.set('voice-profile', new Uint8Array([1, 2, 3]))
    await bot.onboard(A)
    await bot.press(A, 'prof::edit')

    await bot.voice(A, { fileId: 'voice-profile', duration: 3, mimeType: 'audio/ogg', fileSize: 3 })

    expect(await user()).toMatchObject({ profileText: 'работаю по утрам', pendingInput: 'none' })
  })
})


describe.skipIf(!hasDb)('добровольный отчёт: смысл и гонки', () => {
  let A = 5200
  const user = () => prisma.user.findUniqueOrThrow({ where: { tgId: BigInt(A) } })
  beforeEach(async () => { A++; await resetDb() })

  async function waiting(bot: ReturnType<typeof makeBot>) {
    await bot.onboard(A)
    const u = await user()
    await prisma.focusSession.deleteMany({ where: { userId: u.id, state: 'collecting_intent' } })
    const session = await prisma.focusSession.create({ data: {
      userId: u.id, state: 'finished', outcome: 'not_done', plannedMinutes: 40,
      intentText: 'Глава', startedAt: new Date(bot.now().getTime() - 40 * 60000), finishedAt: bot.now(),
    } })
    await prisma.user.update({ where: { id: u.id }, data: { pendingInput: 'report_text' } })
    return session
  }

  it('голосовой явный старт обходит даже ошибочный report-ответ', async () => {
    let reports = 0
    const llm: LlmProvider = { enabled: true, model: 'test', async complete(req) {
      if (req.system.includes('короткий отчёт')) { reports++; return { text: '{"progress":"moved","next_step":null}', usage: null } }
      if (req.system.includes('сообщение пользователя фокус-боту')) return { text: '{"kind":"start_task","start_title":"Фокус-бот"}', usage: null }
      return { text: '{"task":null}', usage: null }
    } }
    const bot = makeBot({ llm, stt: { enabled: true, model: 'test-stt', async transcribe() { return 'Начинаю делать фокус-бот.' } } })
    const previous = await waiting(bot)
    bot.tg.downloads.set('new-work', new Uint8Array([1]))
    await bot.voice(A, { fileId: 'new-work', duration: 3, fileSize: 1 })
    expect(reports).toBe(0)
    expect(await prisma.focusSession.findUniqueOrThrow({ where: { id: previous.id } })).toMatchObject({ reportText: null, progress: null })
    expect(await prisma.focusSession.findFirstOrThrow({ where: { state: 'running' } })).toMatchObject({ intentText: 'Фокус-бот' })
    expect(await prisma.taskTimeAllocation.count({ where: { sessionId: previous.id } })).toBe(0)
  })

  it.each(['new_action', 'unclear'])('route=%s не заполняет старый отчёт', async (route) => {
    let taskParses = 0
    const llm: LlmProvider = { enabled: true, model: 'test', async complete(req) {
      if (req.system.includes('короткий отчёт')) return { text: JSON.stringify({ route, progress: null, next_step: null }), usage: null }
      if (req.system.includes('сообщение пользователя фокус-боту')) { taskParses++; return { text: '{"kind":"start_task","start_title":"Письма"}', usage: null } }
      return { text: '{"task":null}', usage: null }
    } }
    const bot = makeBot({ llm })
    const previous = await waiting(bot)
    await bot.text(A, 'Письма')
    expect(await prisma.focusSession.findUniqueOrThrow({ where: { id: previous.id } })).toMatchObject({ reportText: null, progress: null })
    expect(taskParses).toBe(route === 'new_action' ? 1 : 0)
    expect((await user()).pendingInput).toBe(route === 'new_action' ? 'none' : 'report_text')
  })

  it.each(['report', 'new_action'])('медленный route=%s не затирает новое ожидание', async (route) => {
    let resolve!: (value: { text: string; usage: null }) => void
    let began!: () => void
    const ready = new Promise<void>((r) => { began = r })
    const llm: LlmProvider = { enabled: true, model: 'test', async complete() {
      began()
      return new Promise((r) => { resolve = r })
    } }
    const bot = makeBot({ llm })
    const previous = await waiting(bot)
    const response = bot.text(A, 'Письма')
    await ready
    await bot.press(A, 'prof::edit')
    resolve({ text: JSON.stringify({ route, progress: 'moved', next_step: null }), usage: null })
    await response
    expect((await user()).pendingInput).toBe('profile')
    expect(await prisma.focusSession.findUniqueOrThrow({ where: { id: previous.id } })).toMatchObject({ reportText: null, progress: null })
    expect(await prisma.focusSession.count({ where: { state: 'running' } })).toBe(0)
  })

  it('уточнение со временем встречи не закрывает день', async () => {
    const bot = makeBot({ llm: { enabled: true, model: 'test', async complete() {
      return { text: '{"route":"unclear","progress":null,"next_step":null}', usage: null }
    } } })
    const previous = await waiting(bot)
    await bot.text(A, 'завтра в 9')
    expect((await user()).pendingInput).toBe('report_text')
    expect(await prisma.focusSession.findUniqueOrThrow({ where: { id: previous.id } })).toMatchObject({ reportText: null, restChoice: null })
    expect(await prisma.outboxMessage.count({ where: { kind: 'meeting' } })).toBe(0)
  })

  it.each(['report', 'new_action'])('старый route=%s не забирает отчёт более новой сессии', async (route) => {
    let resolve!: (value: { text: string; usage: null }) => void
    let began!: () => void
    const ready = new Promise<void>((r) => { began = r })
    const bot = makeBot({ llm: { enabled: true, model: 'test', async complete() {
      began(); return new Promise((r) => { resolve = r })
    } } })
    const previous = await waiting(bot)
    const response = bot.text(A, 'Результат, завтра в 9')
    await ready
    // Эмулируем полный новый цикл, пока предыдущая модель отвечает.
    const u = await user()
    const next = await prisma.focusSession.create({ data: {
      userId: u.id, state: 'finished', outcome: 'done', finishedAt: new Date(bot.now().getTime() + 1),
    } })
    resolve({ text: JSON.stringify({ route, progress: 'moved', next_step: null }), usage: null })
    await response
    expect((await user()).pendingInput).toBe('report_text')
    for (const id of [previous.id, next.id]) expect(await prisma.focusSession.findUniqueOrThrow({ where: { id } })).toMatchObject({ reportText: null, progress: null, restChoice: null })
    expect(await prisma.outboxMessage.count({ where: { kind: 'meeting' } })).toBe(0)
  })

})
