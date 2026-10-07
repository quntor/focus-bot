import { lockUser } from '../reminders/store.js'
import { syncReminderState } from '../reminders/sync.js'
import type { Prisma } from '@prisma/client'
import { StaleTransition } from '../session/fsm.js'
import type { Ctx } from './context.js'

// Serialize mutation turns for one owner, not model/provider calls across users.
// The incoming context event is recorded before waiting, so older LLM replies
// still see that a newer input arrived and fail their latest-input fence.
const tails = new Map<string, Promise<void>>()
export async function withUserInputLock(userId: string, work: () => Promise<void>): Promise<void> {
  const previous = tails.get(userId) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>((resolve) => { release = resolve })
  tails.set(userId, current)
  await previous
  try { await work() }
  finally { release(); if (tails.get(userId) === current) tails.delete(userId) }
}

// Transient arrival generation; not a persistent receipt or database version.
const generations = new Map<string, object>()
export function beginInput(key: string): () => boolean {
  const generation = {}
  generations.delete(key)
  if (generations.size >= 10_000) generations.delete(generations.keys().next().value!)
  generations.set(key, generation)
  return () => generations.get(key) === generation
}

// The arrival check at transaction exit rolls back writes made during a DB await.
// With the flag off no fence is applied; existing legacy concurrency is retained.
export function assertCurrentInput(ctx: Ctx): void {
  if (ctx.semanticRouterEnabled && ctx.isCurrentInput && !ctx.isCurrentInput()) throw new StaleTransition()
}
// Fence explicit transitions without resynchronizing their custom reminder chain.
export async function currentInputTransaction<T>(ctx: Ctx, work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return ctx.db.$transaction(async tx => {
    assertCurrentInput(ctx)
    const result = await work(tx)
    assertCurrentInput(ctx)
    return result
  })
}
export async function inputTransaction<T>(ctx: Ctx, work: (tx: Prisma.TransactionClient) => Promise<T>, options: { syncReminders?: boolean } = {}): Promise<T> {
  return ctx.db.$transaction(async (tx) => {
    assertCurrentInput(ctx)
    let before = null
    if (ctx.inputUserId) {
      await lockUser(tx, ctx.inputUserId)
      if (options.syncReminders !== false) before = await tx.focusSession.findFirst({where:{userId:ctx.inputUserId,state:{in:['running','paused','collecting_intent']}}})
      // Rest choice may refer to the last closed session rather than an active one.
      if (options.syncReminders !== false && !before) before = await tx.focusSession.findFirst({where:{userId:ctx.inputUserId},orderBy:{createdAt:'desc'}})
    }
    const result = await work(tx)
    // Adopt the enabled cohort only inside an authorized mutation, never while
    // merely loading a user for feedback, read-only text or a failed model call.
    const existingUser = ctx.inputUserId ? await tx.user.findUnique({ where: { id: ctx.inputUserId } }) : null
    if (options.syncReminders !== false && existingUser && ctx.remindersEnabled && ctx.reminderUserIds?.includes(String(existingUser.tgId))) {
      await tx.user.updateMany({ where: { id: ctx.inputUserId, reminderPolicy: 0 }, data: { reminderPolicy: 1 } })
    }
    if (existingUser && ctx.inputUserId && options.syncReminders !== false) await syncReminderState(tx,ctx.inputUserId,before,ctx.now(),ctx.remindersEnabled===true)
    assertCurrentInput(ctx)
    return result
  })
}
