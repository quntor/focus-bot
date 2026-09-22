import { beforeEach, describe, expect, it } from 'vitest'
import { hasDb, prisma, resetDb } from '../test/db.js'
import { logEvent } from '../analytics/log.js'

describe.skipIf(!hasDb)('дашборд: два разреза', () => {
  beforeEach(resetDb)

  it('DAU и обращения на DAU — по всей базе и по активным, из журнала', async () => {
    const at = new Date('2026-10-01T09:00:00Z')
    const old = new Date('2026-08-01T09:00:00Z')
    // Два активных по 3 обращения, один новичок с одним обращением.
    for (const tgId of [1n, 2n]) {
      const u = await prisma.user.create({ data: { tgId, createdAt: old, lastUserActionAt: new Date(at.getTime() - 86_400_000), countedSessions: 10, role: 'active' } })
      for (let i = 0; i < 3; i++) await logEvent(prisma, u.id, 'intent_submitted', { length_chars: 5, named_minutes: false }, { at })
      await logEvent(prisma, u.id, 'ping_sent', { session_id: '6f1c1f5e-1234-4abc-8def-000000000000' }, { at })
    }
    const n = await prisma.user.create({ data: { tgId: 3n, createdAt: at } })
    await logEvent(prisma, n.id, 'consent_given', {}, { at })

    const all = await prisma.$queryRaw<{ dau: bigint; actions: bigint; actions_per_dau: string }[]>`SELECT * FROM metrics_daily_all`
    expect(all.map((r) => [Number(r.dau), Number(r.actions), Number(r.actions_per_dau)])).toEqual([[3, 7, 2.33]])
    const active = await prisma.$queryRaw<{ dau: bigint; actions: bigint }[]>`SELECT * FROM metrics_daily_by_role WHERE user_role = 'active'`
    expect(active.map((r) => [Number(r.dau), Number(r.actions)])).toEqual([[2, 6]])
  })
})
