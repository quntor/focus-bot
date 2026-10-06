import { randomUUID } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import { lockUser } from '../reminders/store.js'
import { StaleTransition } from '../session/fsm.js'

export async function requireActiveTask(tx: Prisma.TransactionClient, userId: string, taskId: string): Promise<void> {
  await lockUser(tx, userId)
  if (!await tx.task.findFirst({ where: { id: taskId, userId, status: 'active' }, select: { id: true } })) throw new StaleTransition()
}

// Caller supplies a transaction; one owner lock serializes every tree writer.
export async function dropTaskTree(tx: Prisma.TransactionClient, userId: string, rootId: string) {
  await lockUser(tx, userId)
  const root = await tx.task.findFirst({ where: { id: rootId, userId, status: 'active' } })
  if (!root) return { kind: 'stale' as const }
  const ids = new Set([root.id])
  let frontier = [root.id]
  while (frontier.length) {
    const children = await tx.task.findMany({ where: { userId, parentId: { in: frontier } }, select: { id: true } })
    frontier = children.map(c => c.id).filter(id => !ids.has(id))
    frontier.forEach(id => ids.add(id))
  }
  const current = await tx.focusSession.findFirst({ where: { userId, taskId: { in: [...ids] }, state: { in: ['collecting_intent', 'running', 'paused'] } }, select: { id: true } })
  if (current) return { kind: 'busy' as const }
  const operationId = randomUUID()
  const changed = await tx.task.updateMany({ where: { userId, id: { in: [...ids] }, status: 'active' }, data: { status: 'dropped', dropOperationId: operationId } })
  return { kind: 'dropped' as const, title: root.title, count: changed.count, operationId }
}

export async function undoTaskTree(tx: Prisma.TransactionClient, userId: string, operationId: string) {
  await lockUser(tx, userId)
  return tx.task.updateMany({ where: { userId, status: 'dropped', dropOperationId: operationId }, data: { status: 'active', dropOperationId: null } })
}
