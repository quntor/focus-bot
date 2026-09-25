import { beforeEach, describe, expect, it } from 'vitest'
import type { LlmProvider } from '../llm/provider.js'
import type { SttProvider } from '../stt/provider.js'
import { makeBot } from '../test/bot.js'
import { hasDb, prisma, resetDb } from '../test/db.js'

const A = 2085
const B = 2086
const C = 2087

const llm = (answer: string): LlmProvider => ({
  enabled: true,
  async complete(req) {
    if (req.system.includes('сообщение пользователя фокус-боту')) return answer
    throw new Error('unexpected LLM call')
  },
})

const capture = llm(
  '{"kind":"capture","new_tasks":["Подготовить отчёт","Купить корм"],"complete_task":null,"start_task":null,"start_title":null}',
)

describe.skipIf(!hasDb)('список задач из текста и голоса', () => {
  beforeEach(resetDb)

  it('создаёт список из текста, не дублирует его и запускает выбранную задачу', async () => {
    const bot = makeBot({ llm: capture })
    await bot.onboard(A)

    await bot.text(A, 'Сегодня хочу сделать отчёт и купить корм')
    expect(await prisma.task.count()).toBe(2)
    expect(bot.lastText(A)).toContain('Подготовить отчёт')
    expect(bot.lastText(A)).toContain('Купить корм')

    await bot.text(A, 'Сегодня хочу сделать отчёт и купить корм')
    expect(await prisma.task.count()).toBe(2)

    await bot.press(A, bot.lastButton(A, 'task:', ':start'))
    const running = await prisma.focusSession.findFirstOrThrow({ where: { state: 'running' }, include: { task: true } })
    expect(running.task?.title).toBe('Купить корм')
    expect(running.intentText).toBe('Купить корм')
  })

  it('распознаёт voice в памяти и пропускает через тот же парсер', async () => {
    const stt: SttProvider = {
      enabled: true,
      async transcribe(req) {
        expect([...req.audio]).toEqual([1, 2, 3])
        expect(req.mimeType).toBe('audio/ogg')
        return 'Сегодня хочу сделать отчёт и купить корм'
      },
    }
    const bot = makeBot({ llm: capture, stt })
    bot.tg.downloads.set('voice-a', new Uint8Array([1, 2, 3]))
    await bot.onboard(A)

    await bot.voice(A, { fileId: 'voice-a', duration: 12, mimeType: 'audio/ogg', fileSize: 3 })

    expect(await prisma.task.count()).toBe(2)
    expect(bot.textsTo(A)).toContain('Распознал: «Сегодня хочу сделать отчёт и купить корм».')
    expect(await prisma.event.findFirst({ where: { type: 'voice_transcribed' } })).not.toBeNull()
  })

  it('не скачивает слишком длинный voice и безопасно отвечает при выключенном STT', async () => {
    const bot = makeBot({ llm: capture })
    await bot.onboard(A)

    await bot.voice(A, { fileId: 'too-long', duration: 181, mimeType: 'audio/ogg', fileSize: 3 })
    expect(bot.tg.downloadRequests).toEqual([])
    expect(bot.lastText(A)).toContain('не длиннее 3 минут')

    await bot.voice(A, { fileId: 'short', duration: 10, mimeType: 'audio/ogg', fileSize: 3 })
    expect(bot.tg.downloadRequests).toEqual([])
    expect(bot.lastText(A)).toContain('Распознавание голоса сейчас выключено')
  })

  it('ограничивает платное распознавание пятью voice в час до скачивания шестого', async () => {
    const stt: SttProvider = { enabled: true, async transcribe() { return 'Сегодня хочу сделать отчёт и купить корм' } }
    const bot = makeBot({ llm: capture, stt })
    await bot.onboard(C)
    for (let i = 1; i <= 6; i++) {
      bot.tg.downloads.set(`voice-${i}`, new Uint8Array([i]))
      await bot.voice(C, { fileId: `voice-${i}`, duration: 10, mimeType: 'audio/ogg', fileSize: 1 })
    }

    expect(bot.tg.downloadRequests).toHaveLength(5)
    expect(bot.lastText(C)).toContain('до 5 голосовых')
  })

  it('явно завершает текущую задачу и сразу запускает следующую', async () => {
    const switchLlm = llm(
      '{"kind":"complete_and_start","new_tasks":[],"complete_task":"t1","start_task":"t2","start_title":null}',
    )
    const bot = makeBot({ llm: switchLlm })
    await bot.onboard(A)
    const user = await prisma.user.findUniqueOrThrow({ where: { tgId: BigInt(A) } })
    const first = await prisma.task.create({ data: { userId: user.id, title: 'Подготовить презентацию' } })
    const second = await prisma.task.create({ data: { userId: user.id, title: 'Позвонить Ивану' } })

    await bot.press(A, `task:${first.id}:start`)
    bot.advance(10)
    await bot.text(A, 'Эту сделал и приступаю к звонку Ивану')

    expect(await prisma.task.findUniqueOrThrow({ where: { id: first.id } })).toMatchObject({ status: 'done' })
    const finished = await prisma.focusSession.findFirstOrThrow({ where: { taskId: first.id } })
    expect(finished).toMatchObject({ state: 'finished', outcome: 'done', progress: 'moved', restChoice: 'continue' })
    const running = await prisma.focusSession.findFirstOrThrow({ where: { taskId: second.id, state: 'running' } })
    expect(running.intentText).toBe('Позвонить Ивану')
  })

  it('не запускает чужую задачу из поддельного callback', async () => {
    const bot = makeBot({ llm: capture })
    await bot.onboard(A)
    await bot.onboard(B)
    const other = await prisma.user.findUniqueOrThrow({ where: { tgId: BigInt(B) } })
    const task = await prisma.task.create({ data: { userId: other.id, title: 'Чужая задача' } })

    await bot.press(A, `task:${task.id}:start`)

    expect(await prisma.focusSession.count({ where: { taskId: task.id } })).toBe(0)
    expect(bot.lastText(A)).toContain('неактуально')
  })
})
