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

// Основа слова: «презентацию» и «Презентация для клиента» — одна задача.
const stems = (value: string) =>
  normalizeTaskTitle(value)
    .split(' ')
    .filter((word) => word.length >= 3)
    .map((word) => (word.length > 5 ? word.slice(0, 5) : word))

// Задача, которую человек назвал своими словами: сначала точное совпадение,
// потом — все значимые слова названного есть в названии задачи. Из нескольких
// кандидатов выигрывает preferId (текущая задача), иначе никто: гадать нельзя.
export function matchTaskByTitle<T extends { id: string; title: string }>(tasks: T[], title: string, preferId: string | null): T | null {
  const pick = (found: T[]) => found.find((task) => task.id === preferId) ?? (found.length === 1 ? found[0]! : null)
  const key = normalizeTaskTitle(title)
  const exact = tasks.filter((task) => normalizeTaskTitle(task.title) === key)
  if (exact.length) return exact.find((task) => task.id === preferId) ?? exact[0]!
  const wanted = stems(title)
  if (!wanted.length) return null
  return pick(tasks.filter((task) => {
    const have = new Set(stems(task.title))
    return wanted.every((word) => have.has(word))
  }))
}

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
