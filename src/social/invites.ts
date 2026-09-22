import { createHash, randomBytes } from 'node:crypto'
import type { Db } from '../lib/db.js'

// Приглашения. Интерфейса в первой версии нет — функции нужны, чтобы инварианты
// токена были закреплены кодом и тестом до того, как появится кнопка.
//
// Токен — 32 байта из криптографического генератора (256 бит, требование — не
// меньше 128), никак не выводится из идентификатора пользователя. В базе —
// только SHA-256: утечка таблицы не даёт рабочих ссылок. В deep link токен
// помещается целиком: base64url от 32 байт — 43 символа, лимит параметра start —
// 64 символа из A-Z, a-z, 0-9, _ и - (Bot API).
export const TOKEN_BYTES = 32
export const DEFAULT_TTL_MS = 7 * 86_400_000

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex')

export async function createInvite(
  db: Db,
  input: { inviterId: string; now: Date; ttlMs?: number; maxUses?: number },
): Promise<{ token: string; id: string }> {
  const token = randomBytes(TOKEN_BYTES).toString('base64url')
  const row = await db.inviteToken.create({
    data: {
      inviterId: input.inviterId,
      tokenHash: hashToken(token),
      // Дефолт — смотритель. Напарник — только обоюдным подтверждением позже.
      level: 'watcher',
      expiresAt: new Date(input.now.getTime() + (input.ttlMs ?? DEFAULT_TTL_MS)),
      maxUses: input.maxUses ?? 1,
      createdAt: input.now,
    },
  })
  return { token, id: row.id }
}

export async function revokeInvite(db: Db, input: { inviterId: string; inviteId: string; now: Date }): Promise<boolean> {
  const res = await db.inviteToken.updateMany({
    where: { id: input.inviteId, inviterId: input.inviterId, revokedAt: null },
    data: { revokedAt: input.now },
  })
  return res.count === 1
}

// Погашение: срок, число использований и отзыв проверяются одним условным
// UPDATE — два одновременных перехода по одноразовой ссылке не пройдут оба.
// Связь создаётся с уровнем watcher; самого себя пригласить нельзя.
export async function redeemInvite(db: Db, input: { token: string; viewerId: string; now: Date }): Promise<'ok' | 'invalid'> {
  const invite = await db.inviteToken.findUnique({ where: { tokenHash: hashToken(input.token) } })
  if (!invite || invite.inviterId === input.viewerId) return 'invalid'
  const taken = await db.$executeRaw`
    UPDATE invite_tokens SET uses = uses + 1
    WHERE id = ${invite.id} AND revoked_at IS NULL AND expires_at > ${input.now} AND uses < max_uses`
  if (taken !== 1) return 'invalid'
  await db.relationship.upsert({
    where: { ownerId_viewerId: { ownerId: invite.inviterId, viewerId: input.viewerId } },
    create: { ownerId: invite.inviterId, viewerId: input.viewerId, level: 'watcher', createdAt: input.now },
    update: { revokedAt: null, level: 'watcher', partnerConfirmedByOwnerAt: null, partnerConfirmedByViewerAt: null },
  })
  return 'ok'
}

// Уровень связи на сервере. partner — только если стоят оба подтверждения и
// связь не отозвана; во всех остальных случаях — не больше смотрителя.
export function effectiveLevel(rel: {
  level: string
  revokedAt: Date | null
  partnerConfirmedByOwnerAt: Date | null
  partnerConfirmedByViewerAt: Date | null
}): 'none' | 'watcher' | 'partner' {
  if (rel.revokedAt) return 'none'
  if (rel.level === 'partner' && rel.partnerConfirmedByOwnerAt && rel.partnerConfirmedByViewerAt) return 'partner'
  return 'watcher'
}
