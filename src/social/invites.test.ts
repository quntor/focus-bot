import { beforeEach, describe, expect, it } from 'vitest'
import { hasDb, prisma, resetDb } from '../test/db.js'
import { createInvite, effectiveLevel, hashToken, redeemInvite, revokeInvite } from './invites.js'

const now = new Date('2026-09-22T10:00:00Z')

describe('уровень связи', () => {
  it('напарник только при обоюдном подтверждении, отозванная связь — ничего', () => {
    const base = { level: 'partner', revokedAt: null, partnerConfirmedByOwnerAt: now, partnerConfirmedByViewerAt: null }
    expect(effectiveLevel(base)).toBe('watcher')
    expect(effectiveLevel({ ...base, partnerConfirmedByViewerAt: now })).toBe('partner')
    expect(effectiveLevel({ ...base, partnerConfirmedByViewerAt: now, revokedAt: now })).toBe('none')
  })
})

describe.skipIf(!hasDb)('приглашения', () => {
  beforeEach(resetDb)

  it('токен случайный, не меньше 128 бит, не выводится из id и хранится только хэшем', async () => {
    const u = await prisma.user.create({ data: { tgId: 1n } })
    const a = await createInvite(prisma, { inviterId: u.id, now })
    const b = await createInvite(prisma, { inviterId: u.id, now })
    expect(a.token).not.toBe(b.token)
    expect(Buffer.from(a.token, 'base64url').length * 8).toBeGreaterThanOrEqual(128)
    expect(a.token).not.toContain(u.id)
    expect(a.token.length).toBeLessThanOrEqual(64 - 'inv_'.length)
    const rows = await prisma.inviteToken.findMany()
    expect(JSON.stringify(rows)).not.toContain(a.token)
    expect(rows.map((r) => r.tokenHash)).toContain(hashToken(a.token))
  })

  it('срок, число использований и отзыв соблюдаются; уровень по умолчанию — смотритель', async () => {
    const owner = await prisma.user.create({ data: { tgId: 1n } })
    const v1 = await prisma.user.create({ data: { tgId: 2n } })
    const v2 = await prisma.user.create({ data: { tgId: 3n } })
    const inv = await createInvite(prisma, { inviterId: owner.id, now, maxUses: 1 })
    const results = await Promise.all([
      redeemInvite(prisma, { token: inv.token, viewerId: v1.id, now }),
      redeemInvite(prisma, { token: inv.token, viewerId: v2.id, now }),
    ])
    expect(results.filter((r) => r === 'ok')).toHaveLength(1)
    const rel = await prisma.relationship.findFirstOrThrow()
    expect(rel.level).toBe('watcher')

    const expired = await createInvite(prisma, { inviterId: owner.id, now, ttlMs: 1000 })
    expect(await redeemInvite(prisma, { token: expired.token, viewerId: v2.id, now: new Date(now.getTime() + 2000) })).toBe('invalid')

    const revoked = await createInvite(prisma, { inviterId: owner.id, now })
    expect(await revokeInvite(prisma, { inviterId: v1.id, inviteId: revoked.id, now })).toBe(false) // чужой не отзовёт
    expect(await revokeInvite(prisma, { inviterId: owner.id, inviteId: revoked.id, now })).toBe(true)
    expect(await redeemInvite(prisma, { token: revoked.token, viewerId: v2.id, now })).toBe('invalid')

    const self = await createInvite(prisma, { inviterId: owner.id, now })
    expect(await redeemInvite(prisma, { token: self.token, viewerId: owner.id, now })).toBe('invalid')
  })
})
