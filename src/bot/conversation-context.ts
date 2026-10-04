export type ConversationContextRole = 'user' | 'assistant' | 'button'
export type ConversationContextItem = { role: ConversationContextRole; text: string }

type StoredItem = ConversationContextItem & { id: number; at: number }

const MAX_ITEMS = 4
const MAX_TEXT_CHARS = 300
const TTL_MS = 6 * 60 * 60_000
const MAX_USERS = 10_000

const windows = new Map<string, StoredItem[]>()
let nextId = 1
const questions = new Map<string, { pending: string; type: string; pendingAt: number }>()

export function rememberQuestion(userId: string, pending: string, at: Date, type: string): void {
  if (questions.size >= MAX_USERS && !questions.has(userId)) questions.delete(questions.keys().next().value!)
  const prior = questions.get(userId)
  const pendingAt = prior?.pending === pending && at.getTime() - prior.pendingAt <= TTL_MS ? prior.pendingAt : at.getTime()
  questions.set(userId, { pending, type, pendingAt })
}

export function questionContext(userId: string, pending: string, at: Date) {
  const q = questions.get(userId)
  const matching = q && q.pending === pending && at.getTime() - q.pendingAt <= TTL_MS
  return {
    type: matching ? q.type : pending === 'none' ? null : pending.split(':')[0]!,
    // This is the age of a process-observed matching pending question, never
    // an invented DB creation timestamp. No pending (or restart) => unknown.
    ageSeconds: matching && pending !== 'none' ? Math.max(0, Math.floor((at.getTime() - q.pendingAt) / 1000)) : null,
  }
}

export function latestInputId(userId: string, at: Date): number | null {
  return fresh(windows.get(userId) ?? [], at.getTime()).findLast((item) => item.role !== 'assistant')?.id ?? null
}

const normalizedText = (text: string) => text.replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT_CHARS)

function fresh(items: StoredItem[], nowMs: number): StoredItem[] {
  return items.filter((item) => nowMs - item.at <= TTL_MS)
}

function pruneUsers(userId: string, nowMs: number): void {
  if (windows.size < MAX_USERS) return
  for (const [storedUserId, items] of windows) {
    const kept = fresh(items, nowMs)
    if (kept.length) windows.set(storedUserId, kept)
    else windows.delete(storedUserId)
  }
  if (windows.size >= MAX_USERS && !windows.has(userId)) {
    const oldestUserId = windows.keys().next().value as string | undefined
    if (oldestUserId) windows.delete(oldestUserId)
  }
}

// Короткое окно живёт только в памяти процесса. Оно не попадает в БД, события
// или логи и после рестарта безопасно исчезает.
export function rememberConversationContext(
  userId: string,
  role: ConversationContextRole,
  rawText: string,
  at: Date,
): number | null {
  const text = normalizedText(rawText)
  if (!text) return null
  const nowMs = at.getTime()
  pruneUsers(userId, nowMs)
  const id = nextId++
  const items = fresh(windows.get(userId) ?? [], nowMs)
  items.push({ id, role, text, at: nowMs })
  // Пятая запись нужна только как текущая реплика: при запросе к модели она
  // исключается по event id, и в recent_context остаются четыре предыдущих.
  windows.set(userId, items.slice(-(MAX_ITEMS + 1)))
  return id
}

export function recentConversationContext(
  userId: string,
  at: Date,
  options: { beforeEventId?: number | null } = {},
): ConversationContextItem[] {
  const items = fresh(windows.get(userId) ?? [], at.getTime())
  if (items.length) windows.set(userId, items)
  else windows.delete(userId)
  return items
    .filter((item) => options.beforeEventId === undefined || options.beforeEventId === null || item.id < options.beforeEventId)
    .slice(-MAX_ITEMS)
    .map(({ role, text }) => ({ role, text }))
}

export function resetConversationContext(userId: string): void {
  windows.delete(userId)
  questions.delete(userId)
}

// Только для изоляции unit-тестов; production-код очищает окно по userId.
export function clearConversationContext(): void {
  windows.clear()
  questions.clear()
}
