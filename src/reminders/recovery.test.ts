import { beforeEach, describe, expect, it } from 'vitest'
import { hasDb, prisma, resetDb } from '../test/db.js'
import { makeBot } from '../test/bot.js'
import { runOutboxOnce } from '../outbox/worker.js'
import { sweepOnce } from '../jobs/sweeper.js'
import { reconcile } from './store.js'

describe.skipIf(!hasDb)('worker reminder recovery and legacy compatibility', () => {
  beforeEach(resetDb)
  async function setup() {
    const bot = makeBot({ now: new Date('2026-10-05T09:00:00Z') })
    bot.ctx.remindersEnabled = true
    const user = await prisma.user.create({ data: { tgId: 962026n, reminderPolicy: 1 } })
    const session = await prisma.focusSession.create({ data: { userId: user.id, state: 'running', reminderPolicy: 1,
      startedAt: new Date('2026-10-05T06:00:00Z'), plannedEndAt: new Date('2026-10-05T06:40:00Z'), plannedMinutes: 40, plannedRestMinutes: 10 } })
    const due = new Date('2026-10-05T06:40:00Z')
    const chain = await prisma.reminderChain.create({ data: { userId: user.id, sessionId: session.id, kind: 'work',
      phaseStartedAt: session.startedAt!, firstDueAt: due, nextDueAt: due, intervalMinutes: 40 } })
    await prisma.outboxMessage.create({ data: { userId: user.id, kind: 'reminder', chainId: chain.id, chainRevision: 1, ordinal: 0,
      idempotencyKey: `reminder:${chain.id}:1:0`, sendAfter: due } })
    return { ...bot, user, session, chain }
  }

  it('coalesces overdue work into one current question without finishing or replaying past slots', async () => {
    const f = await setup()
    expect(await runOutboxOnce(f.ctx)).toBe(1)
    expect(f.tg.sent).toHaveLength(1)
    const c = await prisma.reminderChain.findUniqueOrThrow({ where: { id: f.chain.id } })
    expect(c.nextDueAt.getTime()).toBe(f.ctx.now().getTime() + 40 * 60_000)
    expect((await prisma.focusSession.findUniqueOrThrow({ where: { id: f.session.id } })).state).toBe('running')
  })

  it('flagoff cancels new slots and reenable reconciliation rematerializes exactly one fenced slot', async () => {
    const f = await setup()
    f.ctx.remindersEnabled = false
    await runOutboxOnce(f.ctx)
    expect(f.tg.sent).toHaveLength(0)
    expect(await prisma.outboxMessage.count({ where: { chainId: f.chain.id, status: 'pending' } })).toBe(0)
    f.ctx.remindersEnabled = true
    await reconcile(f.ctx)
    await reconcile(f.ctx)
    expect(await prisma.outboxMessage.count({ where: { chainId: f.chain.id, status: 'pending' } })).toBe(1)
    await runOutboxOnce(f.ctx)
    expect(f.tg.sent).toHaveLength(1)
  })

  it('rollback guard preserves migrated overdue work and long pauses even with feature off', async () => {
    const f = await setup()
    f.ctx.remindersEnabled = false
    await sweepOnce(f.ctx)
    expect((await prisma.focusSession.findUniqueOrThrow({ where: { id: f.session.id } })).state).toBe('running')
    await prisma.focusSession.update({ where: { id: f.session.id }, data: { state: 'paused', pausedAt: new Date('2026-10-04T01:00:00Z') } })
    await sweepOnce(f.ctx)
    expect((await prisma.focusSession.findUniqueOrThrow({ where: { id: f.session.id } })).state).toBe('paused')
  })

  it('preserves free-mode missed-check auto-finish for migrated owners without applying new-policy timer semantics', async () => {
    const f = await setup()
    await prisma.outboxMessage.deleteMany({ where: { chainId: f.chain.id } })
    await prisma.reminderChain.update({ where: { id: f.chain.id }, data: { status: 'canceled' } })
    const firstPing = new Date('2026-10-05T08:00:00Z')
    await prisma.focusSession.update({ where: { id: f.session.id }, data: { reminderPolicy: 0, plannedMinutes: null,
      plannedEndAt: null, pingAt: firstPing, pingAnsweredAt: null, pingsMissed: 1 } })
    await prisma.outboxMessage.create({ data: { userId: f.user.id, kind: 'ping', idempotencyKey: `ping:${f.session.id}:3`,
      sendAfter: f.ctx.now(), payload: { sessionId: f.session.id, n: 3 } } })
    await runOutboxOnce(f.ctx)
    const session = await prisma.focusSession.findUniqueOrThrow({ where: { id: f.session.id } })
    expect(session.state).toBe('finished')
    expect(session.finishedAt).toEqual(firstPing)
    expect(f.tg.sent).toHaveLength(1)
    expect(await prisma.outboxMessage.count({ where: { userId: f.user.id, kind: 'ping', status: 'pending' } })).toBe(0)
  })

  it('coalesces multiple overdue summary days without a recovery burst or pending-input mutation', async () => {
    const f = await setup()
    await prisma.outboxMessage.deleteMany({ where: { chainId: f.chain.id } })
    await prisma.reminderChain.update({ where: { id: f.chain.id }, data: { status: 'canceled' } })
    await prisma.focusSession.update({ where: { id: f.session.id }, data: { state: 'finished', finishedAt: f.ctx.now() } })
    await prisma.calendarPlan.create({ data: { userId: f.user.id, localDate: '2026-10-05', answer: 'work', source: 'manual_start', answeredAt: f.ctx.now() } })
    for (const dayKey of ['2026-10-03', '2026-10-04']) await prisma.outboxMessage.create({ data: {
      userId: f.user.id, kind: 'summary', idempotencyKey: `summary:${f.user.id}:${dayKey}`,
      sendAfter: new Date('2026-10-05T08:00:00Z'), payload: { dayKey },
    } })
    await runOutboxOnce(f.ctx)
    expect(f.tg.sent).toHaveLength(1)
    expect(await prisma.dailyGoal.findUnique({ where: { userId_dayKey: { userId: f.user.id, dayKey: '2026-10-03' } } })).toBeNull()
    expect((await prisma.dailyGoal.findUniqueOrThrow({ where: { userId_dayKey: { userId: f.user.id, dayKey: '2026-10-04' } } })).summarySentAt).not.toBeNull()
    expect((await prisma.user.findUniqueOrThrow({ where: { id: f.user.id } })).pendingInput).toBe('none')
  })
})
