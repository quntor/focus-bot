import { beforeEach, describe, expect, it } from 'vitest'
import { hasDb, prisma, resetDb } from '../test/db.js'
import { makeBot } from '../test/bot.js'

const A = 1013

describe.skipIf(!hasDb)('онбординг нового пользователя', () => {
  beforeEach(resetDb)

  it('после пропуска ритуала объясняет быстрый старт и способы персонализации', async () => {
    const bot = makeBot()

    await bot.text(A, '/start')
    await bot.text(A, '10:00')
    await bot.press(A, 'skip::ritual')

    const text = bot.lastText(A)
    expect(text).toContain('Быстрый старт')
    expect(text).toContain('Начать сессию')
    expect(text).toContain('Напиши или надиктуй')
    expect(text).toContain('После каждого захода')
    expect(text).toContain('/settings')
    expect(text).toContain('/profile')
    expect(text).toContain('С чего начнёшь?')
    expect((bot.tg.sent.at(-1) as { replyKeyboard?: string[][] } | undefined)?.replyKeyboard).toEqual([
      ['Начать сессию', 'Перерыв'],
      ['Мои задачи'],
    ])
  })

  it('показывает ту же памятку после сохранения ритуала', async () => {
    const bot = makeBot()

    await bot.text(A, '/start')
    await bot.text(A, '10:00')
    await bot.text(A, 'налить воду и закрыть лишние вкладки')

    const text = bot.lastText(A)
    expect(text).toContain('Быстрый старт')
    expect(text).toContain('Ритуал: налить воду и закрыть лишние вкладки.')
    expect(text).toContain('С чего начнёшь?')
  })

  it('не повторяет вводную памятку возвращающемуся пользователю', async () => {
    const bot = makeBot()
    await bot.onboard(A)
    await bot.text(A, '/stop')

    await bot.text(A, '/start')

    expect(bot.lastText(A)).toContain('С возвращением.')
    expect(bot.lastText(A)).not.toContain('Быстрый старт')
    expect(await prisma.user.count({ where: { tgId: BigInt(A) } })).toBe(1)
  })

  it('/help повторяет практические подсказки после онбординга', async () => {
    const bot = makeBot()
    await bot.onboard(A)

    await bot.text(A, '/help')

    expect(bot.lastText(A)).toContain('Быстрый старт')
    expect(bot.lastText(A)).toContain('Как быстрее подстроить меня')
    expect(bot.lastText(A)).toContain('/delete_me')
  })
})
