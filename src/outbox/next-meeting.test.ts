import { beforeEach, describe, expect, it } from 'vitest'
import { makeBot } from '../test/bot.js'
import { hasDb, prisma, resetDb } from '../test/db.js'
import { DeliveryError } from '../tg/client.js'
import { sweepOnce } from '../jobs/sweeper.js'
import { enqueue } from './queue.js'
import { runOutboxOnce } from './worker.js'

// Инвариант: у пользователя с «писать первым» всегда есть следующая встреча.
// Сценарии — из аудита логики 01.10: без него бот замолкал навсегда.
const A = 5201

const user = () => prisma.user.findUniqueOrThrow({ where: { tgId: BigInt(A) } })
const pendingMeetings = async () =>
  prisma.outboxMessage.findMany({ where: { userId: (await user()).id, kind: 'meeting', status: 'pending' }, orderBy: { sendAfter: 'asc' } })

async function morningNow(bot: ReturnType<typeof makeBot>) {
  const u = await user()
  await enqueue(prisma, { userId: u.id, kind: 'meeting', key: `meeting:${u.id}:test-${bot.now().getTime()}`, sendAfter: bot.now(), payload: { defaulted: true, morning: true } })
  await runOutboxOnce(bot.ctx)
}

describe.skipIf(!hasDb)('бот не замолкает', () => {
  beforeEach(resetDb)

  it('пропущенное утро — назавтра утро снова ставится', async () => {
    const bot = makeBot()
    await bot.setupOnboarded(A)
    await morningNow(bot)
    expect(bot.lastText(A)).toContain('Пора работать')

    const next = await pendingMeetings()
    expect(next).toHaveLength(1)
    expect(next[0]!.sendAfter).toEqual(new Date('2026-09-23T07:00:00Z'))
  })

  it('«Третий раз откладываем» без ответа — утро остаётся', async () => {
    const bot = makeBot()
    await bot.setupOnboarded(A)
    for (let i = 0; i < 3; i++) {
      await morningNow(bot)
      bot.advance(60)
    }
    await morningNow(bot)
    expect(bot.textsTo(A)).toContain('Третий раз откладываем. Хочешь паузу или не получается начать?')
    expect(await pendingMeetings()).toHaveLength(1)
  })

  it('выключить и включить «писать первым» — утро появляется сразу', async () => {
    const bot = makeBot()
    await bot.setupOnboarded(A)
    await bot.press(A, 'set::proactive')
    expect(await pendingMeetings()).toHaveLength(0)
    await bot.press(A, 'set::proactive')
    expect(await pendingMeetings()).toHaveLength(1)
  })

  it('страховка: тем, у кого нет ни одного будущего сообщения, ставится утро', async () => {
    const bot = makeBot()
    await bot.setupOnboarded(A)
    await bot.textAs(A, '/stop', {"text":"/stop","route":"control","action":"stop","value":null,"followUp":null})
    expect(await pendingMeetings()).toHaveLength(0)

    await sweepOnce(bot.ctx)

    expect(await pendingMeetings()).toHaveLength(1)
  })

  it('выходной, потом «На сегодня всё» — бот не пишет в сам выходной', async () => {
    const bot = makeBot() // вторник, 10:00 по Москве
    await bot.setupOnboarded(A)
    await bot.textAs(A, '/dayoff', {"text":"/dayoff","route":"control","action":"dayoff","value":null,"followUp":null})
    await bot.textAs(A, '/today', {"text":"/today","route":"close_day","followUp":null})

    const next = await pendingMeetings()
    expect(next).toHaveLength(1)
    // Среда — выходной, утро — в четверг.
    expect(next[0]!.sendAfter).toEqual(new Date('2026-09-24T07:00:00Z'))
  })

  it('смена времени утра переставляет уже поставленную утреннюю встречу', async () => {
    const bot = makeBot()
    await bot.setupOnboarded(A)
    await bot.textAs(A, '/today', {"text":"/today","route":"close_day","followUp":null})
    expect((await pendingMeetings())[0]!.sendAfter).toEqual(new Date('2026-09-23T07:00:00Z'))

    await bot.press(A, 'set::morning')
    await bot.textAs(A, '8:00', {"text":"8:00","route":"answer_pending","answer":{"kind":"clock","hour":8,"minute":0,"day":"next"},"followUp":null})

    const next = await pendingMeetings()
    expect(next).toHaveLength(1)
    expect(next[0]!.sendAfter).toEqual(new Date('2026-09-23T05:00:00Z'))
  })

  it('смена пояса переставляет утреннюю встречу на местное утро', async () => {
    const bot = makeBot()
    await bot.setupOnboarded(A)
    await bot.textAs(A, '/today', {"text":"/today","route":"close_day","followUp":null})
    await bot.press(A, 'set::timezone')
    await bot.textAs(A, '14:00', {"text":"14:00","route":"answer_pending","answer":{"kind":"clock","hour":14,"minute":0,"day":"next"},"followUp":null}) // UTC+7

    const next = await pendingMeetings()
    expect(next).toHaveLength(1)
    expect(next[0]!.sendAfter).toEqual(new Date('2026-09-23T03:00:00Z'))
  })

  it('сбой сети при отправке не засчитывает одно молчание дважды', async () => {
    const bot = makeBot()
    await bot.setupOnboarded(A)
    await morningNow(bot)
    bot.advance(60)
    const u = await user()
    await enqueue(prisma, { userId: u.id, kind: 'meeting', key: `meeting:${u.id}:retry`, sendAfter: bot.now(), payload: { defaulted: false, morning: false } })
    bot.tg.failNext.push(new DeliveryError(false, 'ECONNREFUSED'))
    await runOutboxOnce(bot.ctx)
    bot.advance(1)
    await runOutboxOnce(bot.ctx)

    expect((await user()).declinesInRow).toBe(1)
  })
})
