import { beforeEach, describe, expect, it } from 'vitest'
import { hasDb, prisma, resetDb } from '../test/db.js'
import { makeBot } from '../test/bot.js'
import { ACTIONS } from './callbacks.js'

const A = 2001
const B = 2002
const SECRET_INTENT = 'написать Кате про увольнение'
const SECRET_REPORT = 'разобрал анализы, всё плохо'

describe.skipIf(!hasDb)('IDOR: чужие идентификаторы во всех точках входа', () => {
  beforeEach(resetDb)

  it('пользователь A, подставляя id пользователя B, не получает ни байта чужих данных и ничего не меняет', async () => {
    const bot = makeBot()
    await bot.onboard(A)
    await bot.onboard(B)

    // У B — одна завершённая сессия с отчётом и одна идущая.
    await bot.text(B, `${SECRET_INTENT}, 30 минут`)
    const bUser = await prisma.user.findUniqueOrThrow({ where: { tgId: BigInt(B) } })
    const bFirst = await prisma.focusSession.findFirstOrThrow({ where: { userId: bUser.id } })
    bot.advance(30)
    await bot.press(B, `out:${bFirst.id}:done`)
    await bot.text(B, SECRET_REPORT)
    await bot.press(B, `rest:${bFirst.id}:continue`)
    await bot.text(B, `${SECRET_INTENT} — второй заход, 20 минут`)
    const bSessions = await prisma.focusSession.findMany({ where: { userId: bUser.id }, orderBy: { createdAt: 'asc' } })
    const bTask = await prisma.task.findFirstOrThrow({ where: { userId: bUser.id } })

    const before = JSON.stringify(await prisma.focusSession.findMany({ where: { userId: bUser.id }, orderBy: { id: 'asc' } }))
    const pointsBefore = await prisma.pointsEntry.count({ where: { userId: bUser.id } })
    const aSentBefore = bot.textsTo(A).length

    // Все действия со всеми аргументами — с id каждой сущности B.
    const ids = [...bSessions.map((s) => s.id), bTask.id, bUser.id]
    // Лимит — 30 апдейтов в минуту. Двигаем часы, чтобы каждое нажатие дошло до
    // обработчика, а не отсеялось лимитом: иначе тест прошёл бы, ничего не проверив.
    let n = 0
    const tick = () => {
      if (++n % 25 === 0) bot.advance(1)
    }
    const press = async (data: string) => {
      tick()
      await bot.press(A, data)
    }
    const say = async (t: string) => {
      tick()
      await bot.text(A, t)
    }
    const args = ['ok', 'up', 'down', 'cancel', 'here', 'back', 'done', 'not_done', 'other', 'rest', 'continue', 'later', 'day_end', 'confirm']
    // del проверяется отдельно: он удаляет самого нажавшего, и дальше A был бы
    // новым пользователем без согласия — проверки стали бы пустыми.
    for (const action of ACTIONS.filter((a) => a !== 'del')) {
      for (const id of ids) {
        for (const arg of args) await press(`${action}:${id}:${arg}`)
        await press(`${action}:${id}:`)
      }
    }
    // И через команды и текст: id B в аргументах.
    for (const id of ids) {
      for (const cmd of ['/focus', '/done', '/stop', '/goal', '/profile', '/settings', '/today', '/start']) await say(`${cmd} ${id}`)
      await say(id)
    }

    // Каждое нажатие обработано: лимит не сработал ни разу.
    expect(bot.textsTo(A).slice(aSentBefore)).not.toContain('Слишком быстро — подожди минуту.')
    expect(bot.textsTo(A).length - aSentBefore).toBeGreaterThanOrEqual(n - ids.length * 9)

    // A всё это время оставался собой, с согласием, — значит, обработчики реально
    // отрабатывали, а не отвечали «нужно согласие».
    const aUser = await prisma.user.findUniqueOrThrow({ where: { tgId: BigInt(A) } })
    expect(aUser.consentAt).not.toBeNull()

    // Состояние B не изменилось ни на байт, очков у B не прибавилось.
    const after = JSON.stringify(await prisma.focusSession.findMany({ where: { userId: bUser.id }, orderBy: { id: 'asc' } }))
    expect(after).toBe(before)
    expect(await prisma.pointsEntry.count({ where: { userId: bUser.id } })).toBe(pointsBefore)
    expect(await prisma.user.count({ where: { tgId: BigInt(B) } })).toBe(1)

    // Ни одно сообщение A не содержит данных B.
    const toA = bot.textsTo(A).slice(aSentBefore).join('\n')
    expect(toA).not.toContain('Кате')
    expect(toA).not.toContain('анализы')
    for (const id of ids) expect(toA).not.toContain(id)
    // Кнопки, показанные A, не ссылаются на сущности B.
    const aButtons = bot.buttons(A).map((b) => b.data).join('\n')
    for (const id of ids) expect(aButtons).not.toContain(id)
  }, 30_000)
  it('del с чужим id удаляет только нажавшего, а не владельца id', async () => {
    const bot = makeBot()
    await bot.onboard(A)
    await bot.onboard(B)
    const bUser = await prisma.user.findUniqueOrThrow({ where: { tgId: BigInt(B) } })
    await bot.press(A, `del:${bUser.id}:confirm`)
    expect(await prisma.user.count({ where: { tgId: BigInt(B) } })).toBe(1)
    expect(await prisma.user.count({ where: { tgId: BigInt(A) } })).toBe(0)
  })
})
