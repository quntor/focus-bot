import { beforeEach, describe, expect, it } from 'vitest'
import { hasDb, prisma, resetDb } from '../test/db.js'
import { makeBot } from '../test/bot.js'

const A = 1013

describe.skipIf(!hasDb)('онбординг нового пользователя', () => {
  beforeEach(resetDb)

  it('после пропуска ритуала объясняет быстрый старт и способы персонализации', async () => {
    const bot = makeBot()

    await bot.textAs(A, '/start', {"text":"/start","route":"control","action":"start","value":null,"followUp":null})
    await bot.textAs(A, '10:00', {"text":"10:00","route":"answer_pending","answer":{"kind":"clock","hour":10,"minute":0,"day":"next"},"followUp":null})
    await bot.press(A, 'onb::st_skip')
    await bot.press(A, 'skip::ritual')

    const text = bot.lastText(A)
    expect(text).toContain('Быстрый старт')
    expect(text).toContain('Начать сессию')
    expect(text).toContain('Напиши или надиктуй')
    expect(text).toContain('После каждого захода')
    expect(text).toContain('/settings')
    expect(text).toContain('/profile')
    expect(text).toContain('https://agent07.ru/guide')
    expect(text).toContain('С чего начнёшь?')
    expect((bot.tg.sent.at(-1) as { replyKeyboard?: string[][] } | undefined)?.replyKeyboard).toEqual([
      ['Начать сессию', 'Перерыв'],
      ['Мои задачи', 'Статус'],
    ])
  })

  it('показывает ту же памятку после сохранения ритуала', async () => {
    const bot = makeBot()

    await bot.textAs(A, '/start', {"text":"/start","route":"control","action":"start","value":null,"followUp":null})
    await bot.textAs(A, '10:00', {"text":"10:00","route":"answer_pending","answer":{"kind":"clock","hour":10,"minute":0,"day":"next"},"followUp":null})
    await bot.press(A, 'onb::st_1000')
    await bot.textAs(A, 'налить воду и закрыть лишние вкладки', {"text":"налить воду и закрыть лишние вкладки","route":"answer_pending","answer":{"kind":"text","value":"налить воду и закрыть лишние вкладки"},"followUp":null})

    const text = bot.lastText(A)
    expect(text).toContain('Быстрый старт')
    expect(text).toContain('Ритуал: налить воду и закрыть лишние вкладки.')
    expect(text).toContain('С чего начнёшь?')
  })

  it('подтверждение московского пояса — одно нажатие, затем время старта и ритуал', async () => {
    const bot = makeBot()

    await bot.textAs(A, '/start', {"text":"/start","route":"control","action":"start","value":null,"followUp":null})
    expect(bot.lastText(A)).toContain('У тебя сейчас 10:00, как в Москве?')
    await bot.press(A, 'onb::tz_yes')
    expect(bot.lastText(A)).toBe('Во сколько обычно садишься работать?')
    await bot.press(A, 'onb::st_1200')
    expect(bot.lastText(A)).toContain('Что ты обычно делаешь перед тем, как сесть?')

    const user = await prisma.user.findUniqueOrThrow({ where: { tgId: BigInt(A) } })
    expect(user).toMatchObject({ timezone: 'Europe/Moscow', morningTime: '12:00', pendingInput: 'ritual' })
    const event = await prisma.event.findFirstOrThrow({ where: { type: 'timezone_set' } })
    expect(event.payload).toMatchObject({ via: 'confirmed', offset_minutes: 180 })
  })

  it('«Нет, другое время» — прежний ввод времени, «Своё время» принимает текст', async () => {
    const bot = makeBot()

    await bot.textAs(A, '/start', {"text":"/start","route":"control","action":"start","value":null,"followUp":null})
    await bot.press(A, 'onb::tz_no')
    expect(bot.lastText(A)).toContain('Сколько у тебя сейчас времени?')
    await bot.textAs(A, '12:00', {"text":"12:00","route":"answer_pending","answer":{"kind":"clock","hour":12,"minute":0,"day":"next"},"followUp":null})
    expect(bot.lastText(A)).toBe('Во сколько обычно садишься работать?')
    await bot.press(A, 'onb::st_custom')
    await bot.textAs(A, 'в обед', {"text":"в обед","route":"clarify","question":"Во сколько именно? Напиши время, например 12:00.","followUp":null})
    expect(bot.lastText(A)).toContain('Во сколько именно?')
    await bot.textAs(A, '8:30', {"text":"8:30","route":"answer_pending","answer":{"kind":"clock","hour":8,"minute":30,"day":"next"},"followUp":null})

    const user = await prisma.user.findUniqueOrThrow({ where: { tgId: BigInt(A) } })
    expect(user).toMatchObject({ timezone: 'Asia/Yekaterinburg', morningTime: '08:30', pendingInput: 'ritual' })
  })

  it('«По-разному» не трогает время утра; старые кнопки знакомства не срабатывают повторно', async () => {
    const bot = makeBot()
    await bot.setupOnboarded(A)
    const before = await prisma.user.findUniqueOrThrow({ where: { tgId: BigInt(A) } })
    expect(before.morningTime).toBe('10:00')

    await bot.press(A, 'onb::tz_yes')
    expect(bot.lastText(A)).toBe('Это уже неактуально.')
    await bot.press(A, 'onb::st_0900')
    expect(bot.lastText(A)).toBe('Это уже неактуально.')
    expect(await prisma.user.findUniqueOrThrow({ where: { tgId: BigInt(A) } })).toMatchObject({ morningTime: '10:00', pendingInput: before.pendingInput })
  })

  it('/start посреди знакомства продолжает с шага времени старта', async () => {
    const bot = makeBot()
    await bot.textAs(A, '/start', {"text":"/start","route":"control","action":"start","value":null,"followUp":null})
    await bot.press(A, 'onb::tz_yes')

    await bot.textAs(A, '/start', {"text":"/start","route":"control","action":"start","value":null,"followUp":null})

    expect(bot.lastText(A)).toBe('Во сколько обычно садишься работать?')
  })

  it('не повторяет вводную памятку возвращающемуся пользователю', async () => {
    const bot = makeBot()
    await bot.setupOnboarded(A)
    await bot.textAs(A, '/stop', {"text":"/stop","route":"control","action":"stop","value":null,"followUp":null})

    await bot.textAs(A, '/start', {"text":"/start","route":"control","action":"start","value":null,"followUp":null})

    expect(bot.lastText(A)).toContain('С возвращением.')
    expect(bot.lastText(A)).not.toContain('Быстрый старт')
    expect(await prisma.user.count({ where: { tgId: BigInt(A) } })).toBe(1)
  })

  it('/help повторяет практические подсказки после онбординга', async () => {
    const bot = makeBot()
    await bot.setupOnboarded(A)

    await bot.textAs(A, '/help', {"text":"/help","route":"control","action":"help","value":null,"followUp":null})

    expect(bot.lastText(A)).toContain('Быстрый старт')
    expect(bot.lastText(A)).toContain('Как быстрее подстроить меня')
    expect(bot.lastText(A)).toContain('https://agent07.ru/guide')
    expect(bot.lastText(A)).toContain('/delete_me')
  })

  it('/guide открывает подробную инструкцию и остаётся в /help', async () => {
    const bot = makeBot()
    await bot.setupOnboarded(A)
    await prisma.user.update({ where: { tgId: BigInt(A) }, data: { pendingInput: 'profile' } })

    await bot.textAs(A, '/guide', {"text":"/guide","route":"control","action":"guide","value":null,"followUp":null})

    expect(bot.lastText(A)).toContain('Подробная инструкция')
    expect(bot.lastText(A)).toContain('https://agent07.ru/guide')
    expect(await prisma.user.findUniqueOrThrow({ where: { tgId: BigInt(A) } })).toMatchObject({ pendingInput: 'profile' })

    await bot.textAs(A, '/help', {"text":"/help","route":"control","action":"help","value":null,"followUp":null})
    expect(bot.lastText(A)).toContain('/guide — подробная инструкция')
  })

  it('/guide до /start создаёт только технического пользователя и не заменяет первое знакомство', async () => {
    const bot = makeBot()

    await bot.textAs(A, '/guide', {"text":"/guide","route":"control","action":"guide","value":null,"followUp":null})

    expect(bot.lastText(A)).toContain('https://agent07.ru/guide')
    expect(await prisma.user.findUnique({ where: { tgId: BigInt(A) } })).toMatchObject({ pendingInput: 'none' })
    expect(await prisma.focusSession.count()).toBe(0)

    await bot.textAs(A, '/start', {"text":"/start","route":"control","action":"start","value":null,"followUp":null})
    expect(bot.lastText(A)).toContain('У тебя сейчас 10:00, как в Москве?')
  })

  it('старая кнопка согласия не перезапускает пройденное знакомство', async () => {
    const bot = makeBot()
    await bot.setupOnboarded(A)

    await bot.press(A, 'consent::')

    expect(bot.lastText(A)).toBe('Это уже неактуально.')
    expect(await prisma.user.findUniqueOrThrow({ where: { tgId: BigInt(A) } })).toMatchObject({ pendingInput: 'none' })
  })
})
