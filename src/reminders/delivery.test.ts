import { beforeEach, describe, expect, it } from 'vitest'
import { hasDb, prisma, resetDb } from '../test/db.js'
import { makeBot } from '../test/bot.js'
import { DeliveryError, TelegramError } from '../tg/client.js'
import { fallbackReminder } from '../llm/reminder.js'
import { deliverReminder, recoverReminder, reminderKeyboard } from './delivery.js'

describe('reminder callback encoding', () => {
  it('keeps ownership pointers within Telegram limits in every phase', () => {
    for (const phase of ['morning', 'work', 'break', 'post_rest'] as const) {
      const buttons = reminderKeyboard('12345678-1234-1234-1234-123456789012', phase).flat()
      expect(buttons).toHaveLength(4)
      for (const button of buttons) expect(Buffer.byteLength(button.data)).toBeLessThanOrEqual(64)
    }
  })
})

describe.skipIf(!hasDb)('persistent reminder delivery', () => {
  beforeEach(resetDb)
  async function setup() {
    const bot = makeBot({ now: new Date('2026-10-05T09:00:00Z') })
    bot.ctx.remindersEnabled = true
    const now = bot.ctx.now()
    const user = await prisma.user.create({ data: { tgId: 902026n, reminderPolicy: 1 } })
    const session = await prisma.focusSession.create({ data: { userId: user.id, state: 'running', reminderPolicy: 1, startedAt: new Date(now.getTime() - 40 * 60_000), plannedMinutes: 40, plannedRestMinutes: 10 } })
    const chain = await prisma.reminderChain.create({ data: { userId: user.id, kind: 'work', sessionId: session.id, phaseStartedAt: session.startedAt!, firstDueAt: now, nextDueAt: now, intervalMinutes: 40 } })
    const message = await prisma.outboxMessage.create({ data: { userId: user.id, kind: 'reminder', chainId: chain.id, chainRevision: 1, ordinal: 0, idempotencyKey: `reminder:${chain.id}:1:0`, sendAfter: now, status: 'sending', attempts: 1, lockedUntil: new Date(now.getTime() + 60_000) } })
    return { ...bot, user, session, chain, message }
  }
  it('delivers once and persists anchor and exactly one successor without finishing work', async () => {
    const f = await setup()
    await deliverReminder(f.ctx, f.message)
    await deliverReminder(f.ctx, f.message)
    expect(f.tg.sent).toHaveLength(1)
    expect((await prisma.focusSession.findUniqueOrThrow({ where: { id: f.session.id } })).state).toBe('running')
    const chain = await prisma.reminderChain.findUniqueOrThrow({ where: { id: f.chain.id } })
    expect(chain.ordinal).toBe(1)
    expect(chain.nextDueAt.getTime()).toBe(f.ctx.now().getTime() + 40 * 60_000)
    expect(await prisma.outboxMessage.count({ where: { chainId: chain.id, status: 'pending' } })).toBe(1)
  })
  it('429 retries cached text without advancing cadence or replaying generation', async () => {
    const f = await setup()
    f.tg.failNext.push(new TelegramError('rate', 429, 15))
    await deliverReminder(f.ctx, f.message)
    const retry = await prisma.outboxMessage.findUniqueOrThrow({ where: { id: f.message.id } })
    expect(retry.status).toBe('pending')
    expect(retry.generatedText).toBe(fallbackReminder('work').text)
    expect(retry.sendAttemptStartedAt).toBeNull()
    expect((await prisma.reminderChain.findUniqueOrThrow({ where: { id: f.chain.id } })).ordinal).toBe(0)
    expect(await prisma.outboxMessage.count({ where: { chainId: f.chain.id } })).toBe(1)
  })
  it('unknown send advances from persisted start and does not resend', async () => {
    const f = await setup()
    f.tg.failNext.push(new DeliveryError(true, 'timeout'))
    await deliverReminder(f.ctx, f.message)
    expect((await prisma.outboxMessage.findUniqueOrThrow({ where: { id: f.message.id } })).status).toBe('uncertain')
    expect((await prisma.reminderChain.findUniqueOrThrow({ where: { id: f.chain.id } })).ordinal).toBe(1)
    await deliverReminder(f.ctx, f.message)
    expect(f.tg.sent).toHaveLength(0)
  })
  it('recovery before send requeues, after send advances once under concurrent recovery', async () => {
    const f = await setup()
    const expired = new Date(f.ctx.now().getTime() - 1)
    await prisma.outboxMessage.update({ where: { id: f.message.id }, data: { lockedUntil: expired, generationStatus: 'started', generationToken: 'old' } })
    await recoverReminder(f.ctx, f.message)
    expect((await prisma.outboxMessage.findUniqueOrThrow({ where: { id: f.message.id } })).generationStatus).toBe('uncertain')
    expect((await prisma.reminderChain.findUniqueOrThrow({ where: { id: f.chain.id } })).ordinal).toBe(0)
    await prisma.outboxMessage.update({ where: { id: f.message.id }, data: { status: 'sending', lockedUntil: expired, sendAttemptStartedAt: f.ctx.now() } })
    await Promise.all([recoverReminder(f.ctx, f.message), recoverReminder(f.ctx, f.message)])
    expect((await prisma.reminderChain.findUniqueOrThrow({ where: { id: f.chain.id } })).ordinal).toBe(1)
    expect(await prisma.outboxMessage.count({ where: { chainId: f.chain.id, status: 'pending' } })).toBe(1)
  })
  it('quiet delays the existing slot without finishing the session', async () => {
    const f = await setup()
    const quietUntil = new Date('2026-10-05T21:00:00Z')
    await prisma.user.update({ where: { id: f.user.id }, data: { quietUntil } })
    await deliverReminder(f.ctx, f.message)
    expect(f.tg.sent).toHaveLength(0)
    const m = await prisma.outboxMessage.findUniqueOrThrow({ where: { id: f.message.id } })
    expect(m.status).toBe('pending')
    expect(m.sendAfter).toEqual(new Date('2026-10-06T07:00:00Z'))
    expect((await prisma.focusSession.findUniqueOrThrow({ where: { id: f.session.id } })).state).toBe('running')
  })
  it('concurrent delivery calls generate once and suppress output when quiet arrives during generation', async () => {
    const f = await setup()
    let finish!: () => void
    let began!: () => void
    const started = new Promise<void>((resolve) => { began = resolve })
    const paused = new Promise<void>((resolve) => { finish = resolve })
    let calls = 0
    f.ctx.llm = { enabled: true, model: 'test', async complete() {
      calls++; began(); await paused
      return { text: JSON.stringify(fallbackReminder('work')), usage: null }
    } }
    const first = deliverReminder(f.ctx, f.message)
    await started
    await deliverReminder(f.ctx, f.message)
    await prisma.user.update({ where: { id: f.user.id }, data: { quietUntil: new Date('2026-10-05T21:00:00Z') } })
    finish()
    await first
    expect(calls).toBe(1)
    expect(f.tg.sent).toHaveLength(0)
    expect((await prisma.outboxMessage.findUniqueOrThrow({ where: { id: f.message.id } })).status).toBe('pending')
    expect((await prisma.reminderChain.findUniqueOrThrow({ where: { id: f.chain.id } })).ordinal).toBe(0)
  })
  it('rollback delivery flag preserves phase and never contacts the provider', async () => {
    const f = await setup()
    f.ctx.remindersEnabled = false
    f.ctx.llm = { enabled: true, model: 'test', async complete() { throw new Error('must not generate') } }
    await deliverReminder(f.ctx, f.message)
    expect(f.tg.sent).toHaveLength(0)
    expect((await prisma.outboxMessage.findUniqueOrThrow({ where: { id: f.message.id } })).status).toBe('canceled')
    expect((await prisma.reminderChain.findUniqueOrThrow({ where: { id: f.chain.id } })).status).toBe('active')
  })
})
