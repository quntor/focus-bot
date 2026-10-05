import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PrismaClient } from '@prisma/client'
import { llmMeter, LLM_CALLS_PER_DAY, type CallName } from './calls.js'
import { hasDb, prisma, resetDb } from '../test/db.js'

const now = new Date('2026-10-05T09:00:00Z')
const metadata = { latencyMs: 20, status: 'invalid' as const, errorCode: 'schema', model: 'mock', usage: { inputTokens: 5, outputTokens: 3 } }

describe('hard LLM budget failure policy', () => {
  it('fails closed before provider I/O if atomic reservation is unavailable', async () => {
    const db = { $transaction: vi.fn(async () => { throw new Error('reservation unavailable') }) } as unknown as PrismaClient
    const meter = llmMeter({ db, now: () => now }, 'user', 'reminder_text', null)
    expect(await meter.allow!()).toBe(false)
    expect(db.$transaction).toHaveBeenCalledTimes(1)
  })
})

describe.skipIf(!hasDb)('shared persistent LLM reservations', () => {
  beforeEach(resetDb)
  async function setup(used = 299) {
    const user = await prisma.user.create({ data: { tgId: 910026n } })
    await prisma.componentCall.createMany({ data: Array.from({ length: used }, () => ({ subjectId: user.subjectId, component: 'llm', name: 'tasks', status: 'ok', latencyMs: 1, createdAt: new Date(now.getTime() - 60_000) })) })
    return { user, ctx: { db: prisma, now: () => now } }
  }
  it('at 299 concurrent reminder, STT and interactive calls reserve exactly one shared remaining attempt', async () => {
    const { ctx, user } = await setup()
    const names: CallName[] = ['reminder_text', 'voice_transcription', 'intent', 'tasks', 'report', 'session_help']
    const meters = names.map((name) => llmMeter(ctx, user.id, name, null))
    const allowed = await Promise.all(meters.map((meter) => meter.allow!()))
    expect(allowed.filter(Boolean)).toHaveLength(1)
    const winner = allowed.findIndex(Boolean)
    await meters[winner]!(metadata)
    expect(await prisma.componentCall.count()).toBe(LLM_CALLS_PER_DAY)
    expect(await prisma.llmBudgetReservation.count()).toBe(1)
    expect((await prisma.llmBudgetReservation.findFirstOrThrow()).componentCallId).not.toBeNull()
    expect(await prisma.event.count({ where: { type: 'llm_budget_exceeded' } })).toBe(1)
    expect(await llmMeter(ctx, user.id, 'reminder_text', null).allow!()).toBe(false)
  })
  it('linked actual calls and reservations consume one slot, not two', async () => {
    const { ctx, user } = await setup(298)
    const first = llmMeter(ctx, user.id, 'reminder_text', null)
    expect(await first.allow!()).toBe(true)
    await first(metadata)
    const second = llmMeter(ctx, user.id, 'voice_transcription', null)
    expect(await second.allow!()).toBe(true)
    await second({ ...metadata, status: 'error', errorCode: 'network', usage: null })
    expect(await llmMeter(ctx, user.id, 'tasks', null).allow!()).toBe(false)
    expect(await prisma.componentCall.count()).toBe(300)
  })
  it('a crash after reservation stays charged and is not reported as an actual component call', async () => {
    const { ctx, user } = await setup()
    expect(await llmMeter(ctx, user.id, 'reminder_text', null).allow!()).toBe(true)
    expect(await llmMeter(ctx, user.id, 'voice_transcription', null).allow!()).toBe(false)
    expect(await prisma.componentCall.count()).toBe(299)
    expect((await prisma.llmBudgetReservation.findFirstOrThrow()).componentCallId).toBeNull()
  })
  it('expired reservations do not hide linked actual calls still inside the rolling day', async () => {
    const { ctx, user } = await setup(299)
    const call = await prisma.componentCall.create({ data: {
      subjectId: user.subjectId, component: 'llm', name: 'reminder_text', status: 'ok',
      latencyMs: 2500, createdAt: new Date(now.getTime() - 86_399_000),
    } })
    await prisma.llmBudgetReservation.create({ data: {
      id: '5c2c468f-3e14-4939-885e-8b043f1e2c72', subjectId: user.subjectId,
      reservedAt: new Date(now.getTime() - 86_401_000), componentCallId: call.id,
    } })
    expect(await llmMeter(ctx, user.id, 'reminder_text', null).allow!()).toBe(false)
    expect(await prisma.componentCall.count()).toBe(300)
    expect(await prisma.llmBudgetReservation.count()).toBe(1)
  })
  it('old reservations and old legacy calls expire together after a rolling day', async () => {
    const { ctx, user } = await setup()
    expect(await llmMeter(ctx, user.id, 'reminder_text', null).allow!()).toBe(true)
    const later = { db: prisma, now: () => new Date(now.getTime() + 86_400_001) }
    expect(await llmMeter(later, user.id, 'reminder_text', null).allow!()).toBe(true)
  })
})
