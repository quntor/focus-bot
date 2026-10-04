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
export async function inputTransaction<T>(ctx: Ctx, work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return ctx.db.$transaction(async (tx) => {
    assertCurrentInput(ctx)
    const result = await work(tx)
    assertCurrentInput(ctx)
    return result
  })
}
