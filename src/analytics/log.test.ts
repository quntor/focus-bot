import { beforeEach, describe, expect, it } from 'vitest'
import { hasDb, prisma, resetDb } from '../test/db.js'
import { logEvent } from './log.js'

describe.skipIf(!hasDb)('журнал событий', () => {
  beforeEach(resetDb)

  it('пишет псевдоним и роль на момент события, а не id пользователя', async () => {
    const user = await prisma.user.create({ data: { tgId: 1n, timezone: 'Asia/Vladivostok' } })
    await logEvent(prisma, user.id, 'consent_given', {}, { at: new Date('2026-09-14T22:10:00Z') })
    const [event] = await prisma.event.findMany()
    expect(event?.subjectId).toBe(user.subjectId)
    expect(event?.subjectId).not.toBe(user.id)
    expect(event?.userRole).toBe('new')
    expect(event?.isUserAction).toBe(true)
    // День — пользовательский: во Владивостоке это уже 15-е.
    expect(event?.dayKey).toBe('2026-09-15')
  })

  it('роль меняется с записью в историю: уснувший вернулся', async () => {
    const old = new Date('2026-08-01T10:00:00Z')
    const user = await prisma.user.create({
      data: { tgId: 2n, createdAt: old, lastUserActionAt: old, countedSessions: 10, role: 'active' },
    })
    await logEvent(prisma, user.id, 'intent_submitted', { length_chars: 10, named_minutes: false }, { at: new Date('2026-09-22T10:00:00Z') })
    const [event] = await prisma.event.findMany()
    expect(event?.userRole).toBe('dormant')
    const transitions = await prisma.roleTransition.findMany({ orderBy: { id: 'asc' } })
    expect(transitions.map((t) => `${t.fromRole}>${t.toRole}`)).toEqual(['active>dormant', 'dormant>active'])
  })

  it('отвергает payload со свободным текстом', async () => {
    const user = await prisma.user.create({ data: { tgId: 3n } })
    await expect(
      logEvent(prisma, user.id, 'consent_given', { text: 'разобрать анализы' } as never),
    ).rejects.toThrow()
    expect(await prisma.event.count()).toBe(0)
  })

  it('журнал нельзя править и удалять задним числом', async () => {
    const user = await prisma.user.create({ data: { tgId: 4n } })
    await logEvent(prisma, user.id, 'consent_given', {})
    await expect(prisma.event.updateMany({ data: { type: 'x' } })).rejects.toThrow()
    await expect(prisma.event.deleteMany({})).rejects.toThrow()
    expect(await prisma.event.count()).toBe(1)
  })
})
