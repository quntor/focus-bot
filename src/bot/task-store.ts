import type { Prisma } from '@prisma/client'

// Одно место, где создаётся задача по названию. Раньше каждый путь создавал
// её сам, и «поработаю над слайдами» появлялась рядом с уже существующей
// «Слайды». Совпадение — по нормализованному названию среди активных задач
// этого пользователя; фильтр по userId — единственный источник владельца.
export const normalizeTaskTitle = (value: string) =>
  value
    .toLocaleLowerCase('ru')
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()

export const cleanTaskTitle = (value: string) => value.replace(/\s+/g, ' ').trim().slice(0, 80)

export async function findOrCreateTask(
  tx: Prisma.TransactionClient,
  input: { userId: string; title: string; now: Date; parentId?: string | null },
): Promise<{ id: string; title: string; created: boolean }> {
  const title = cleanTaskTitle(input.title)
  const key = normalizeTaskTitle(title)
  const active = await tx.task.findMany({ where: { userId: input.userId, status: 'active' }, select: { id: true, title: true } })
  const existing = active.find((task) => normalizeTaskTitle(task.title) === key)
  if (existing) return { ...existing, created: false }
  const created = await tx.task.create({
    data: { userId: input.userId, title, createdAt: input.now, ...(input.parentId ? { parentId: input.parentId } : {}) },
    select: { id: true, title: true },
  })
  return { ...created, created: true }
}
