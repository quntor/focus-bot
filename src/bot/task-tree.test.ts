import { beforeEach, describe, expect, it, vi } from 'vitest'
import { dropTaskTree } from './task-tree.js'
import { lockUser } from '../reminders/store.js'
import { onTaskBreakdownAnswer, onTaskDropped } from './tasks.js'
import { startTaskSession } from './session-flow.js'
import { makeBot } from '../test/bot.js'
import { hasDb, prisma, resetDb } from '../test/db.js'

const A = 3091
const B = 3092

describe.skipIf(!hasDb)('cascade delete through Telegram', () => {
  beforeEach(resetDb)
  it('drops active descendants through inactive nodes and restores only this operation', async () => {
    const bot = makeBot()
    await bot.setupOnboarded(A)
    await bot.setupOnboarded(B)
    const user = await prisma.user.findUniqueOrThrow({ where: { tgId: BigInt(A) } })
    const root = await prisma.task.create({ data: { userId: user.id, title: 'Презентация', sessionsCount: 3 } })
    const done = await prisma.task.create({ data: { userId: user.id, title: 'Тема', status: 'done', parentId: root.id } })
    const old = await prisma.task.create({ data: { userId: user.id, title: 'Черновик', status: 'dropped', parentId: root.id } })
    const leaf = await prisma.task.create({ data: { userId: user.id, title: 'Цифры', parentId: done.id } })
    const deep = await prisma.task.create({ data: { userId: user.id, title: 'Материалы', parentId: old.id } })
    const neighbor = await prisma.task.create({ data: { userId: user.id, title: 'Сосед' } })
    const history = await prisma.focusSession.create({ data: { userId: user.id, taskId: root.id, state: 'finished', startedAt: new Date('2026-09-21T07:00:00Z'), finishedAt: new Date('2026-09-21T07:35:00Z') } })
    const allocation = await prisma.taskTimeAllocation.create({ data: { userId: user.id, sessionId: history.id, taskId: root.id, seconds: 2100 } })
    const before = await prisma.task.findMany({ orderBy: { id: 'asc' } })
    await bot.press(A, `task:${root.id}:drop`)
    for (const id of [root.id, leaf.id, deep.id]) expect(await prisma.task.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: 'dropped' })
    const undo = bot.buttons(A).find(b => b.data.startsWith('taskundo:'))!.data
    expect(Buffer.byteLength(undo)).toBeLessThanOrEqual(64)
    await bot.press(B, undo)
    expect(await prisma.task.count({ where: { userId: user.id, status: 'active' } })).toBe(1)
    await bot.press(A, `task:${root.id}:restore`)
    expect(await prisma.task.findUniqueOrThrow({ where: { id: root.id } })).toMatchObject({ status: 'dropped' })
    await makeBot().press(A, undo)
    expect(await prisma.focusSession.findUniqueOrThrow({ where: { id: history.id } })).toEqual(history)
    expect(await prisma.taskTimeAllocation.findUniqueOrThrow({ where: { id: allocation.id } })).toEqual(allocation)
    expect(await prisma.task.findMany({ orderBy: { id: 'asc' } })).toEqual(before)
    await bot.press(A, `task:${root.id}:drop`)
    await bot.press(A, undo)
    expect(await prisma.task.findUniqueOrThrow({ where: { id: root.id } })).toMatchObject({ status: 'dropped', sessionsCount: 3 })
    expect(await prisma.task.findUniqueOrThrow({ where: { id: neighbor.id } })).toMatchObject({ status: 'active' })
  })
  it.each(['collecting_intent', 'running', 'paused'] as const)('blocks the whole tree when a deep descendant is %s', async state => {
    const bot = makeBot()
    await bot.setupOnboarded(A)
    const user = await prisma.user.findUniqueOrThrow({ where: { tgId: BigInt(A) } })
    const root = await prisma.task.create({ data: { userId: user.id, title: 'Родитель' } })
    const middle = await prisma.task.create({ data: { userId: user.id, title: 'Закрытый шаг', parentId: root.id, status: 'done' } })
    const leaf = await prisma.task.create({ data: { userId: user.id, title: 'Шаг', parentId: middle.id } })
    const session = await prisma.focusSession.findFirstOrThrow({ where: { userId: user.id } })
    const current = await prisma.focusSession.update({ where: { id: session.id }, data: { taskId: leaf.id, state } })
    await bot.press(A, `task:${root.id}:drop`)
    expect(await prisma.task.count({ where: { userId: user.id, status: 'active' } })).toBe(2)
    expect(await prisma.focusSession.findUniqueOrThrow({ where: { id: session.id } })).toEqual(current)
    expect(bot.lastText(A)).toContain('подзадача')
  })
  it('preserves paused reminder accounting for busy, successful delete, undo and legacy restore', async () => {
    const bot = makeBot()
    await bot.setupOnboarded(A)
    const user = await prisma.user.findUniqueOrThrow({ where: { tgId: BigInt(A) } })
    const root = await prisma.task.create({ data: { userId: user.id, title: 'Родитель' } })
    const leaf = await prisma.task.create({ data: { userId: user.id, title: 'Шаг', parentId: root.id } })
    const other = await prisma.task.create({ data: { userId: user.id, title: 'Другая' } })
    const legacy = await prisma.task.create({ data: { userId: user.id, title: 'Старая', status: 'dropped' } })
    const session = await prisma.focusSession.findFirstOrThrow({ where: { userId: user.id } })
    const startedAt = new Date('2026-09-21T07:00:00Z')
    const pausedAt = new Date('2026-09-21T07:25:00Z')
    await prisma.focusSession.update({ where: { id: session.id }, data: { state: 'paused', taskId: leaf.id, reminderPolicy: 1, plannedMinutes: 25, startedAt, pausedAt } })
    await prisma.workPeriod.create({ data: { sessionId: session.id, startedAt, endedAt: pausedAt } })
    await prisma.event.create({ data: { subjectId: user.subjectId, sessionId: session.id, type: 'session_started', userRole: 'active', dayKey: '2026-09-21', payload: { task_id: leaf.id }, createdAt: startedAt } })
    await prisma.taskTimeAllocation.create({ data: { userId: user.id, sessionId: session.id, taskId: leaf.id, seconds: 1500, source: 'timeline' } })
    const snapshot = async () => ({ session: await prisma.focusSession.findUnique({ where: { id: session.id } }), periods: await prisma.workPeriod.findMany(), allocations: await prisma.taskTimeAllocation.findMany() })
    const before = await snapshot()
    await bot.press(A, `task:${root.id}:drop`)
    expect(bot.lastText(A)).toContain('подзадача')
    expect(await snapshot()).toEqual(before)
    await bot.press(A, `task:${other.id}:drop`)
    const undo = bot.buttons(A).find(b => b.data.startsWith('taskundo:'))!.data
    expect(await snapshot()).toEqual(before)
    await bot.press(A, undo)
    await bot.press(A, `task:${legacy.id}:restore`)
    expect(await snapshot()).toEqual(before)
  })
  it('keeps legacy restore, owner boundaries and three-level listing', async () => {
    const bot = makeBot()
    await bot.setupOnboarded(A)
    await bot.setupOnboarded(B)
    const user = await prisma.user.findUniqueOrThrow({ where: { tgId: BigInt(A) } })
    const root = await prisma.task.create({ data: { userId: user.id, title: 'Родитель' } })
    const child = await prisma.task.create({ data: { userId: user.id, title: 'Ребёнок', parentId: root.id } })
    const leaf = await prisma.task.create({ data: { userId: user.id, title: 'Внук', parentId: child.id } })
    await bot.textAs(A, '/tasks', {"text":"/tasks","route":"control","action":"tasks","value":null,"followUp":null})
    expect(bot.lastText(A)).toContain('Внук')
    await bot.press(B, `task:${root.id}:drop`)
    expect(await prisma.task.count({ where: { userId: user.id, status: 'active' } })).toBe(3)
    await prisma.task.update({ where: { id: leaf.id }, data: { status: 'dropped' } })
    await bot.press(A, `task:${leaf.id}:restore`)
    expect(await prisma.task.findUniqueOrThrow({ where: { id: leaf.id } })).toMatchObject({ status: 'active', dropOperationId: null })
  })
  it.each(['delete', 'start'] as const)('serializes real DB delete/start with %s winning the lock', async winner => {
    const bot = makeBot()
    await bot.setupOnboarded(A)
    const user = await prisma.user.findUniqueOrThrow({ where: { tgId: BigInt(A) } })
    const root = await prisma.task.create({ data: { userId: user.id, title: 'Родитель' } })
    const leaf = await prisma.task.create({ data: { userId: user.id, title: 'Шаг', parentId: root.id } })
    let entered!: () => void
    const ready = new Promise<void>(r => { entered = r })
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    const first = prisma.$transaction(async tx => {
      await lockUser(tx, user.id)
      if (winner === 'delete') await dropTaskTree(tx, user.id, root.id)
      else await tx.focusSession.updateMany({ where: { userId: user.id, state: 'collecting_intent' }, data: { taskId: leaf.id } })
      entered()
      await gate
    })
    await ready
    let read!: () => void
    const readReady = new Promise<void>(r => { read = r })
    const findFirst = prisma.task.findFirst.bind(prisma.task)
    const spy = winner === 'delete' ? vi.spyOn(prisma.task, 'findFirst').mockImplementationOnce((async (args: Parameters<typeof findFirst>[0]) => {
      const result = await findFirst(args)
      read()
      return result
    }) as typeof findFirst) : null
    const second = winner === 'delete' ? startTaskSession(bot.ctx, user, leaf.id) : onTaskDropped(bot.ctx, user, root.id)
    if (winner === 'delete') await readReady // old active snapshot is guaranteed before the delete commits
    release()
    await Promise.all([first, second])
    spy?.mockRestore()
    const task = await prisma.task.findUniqueOrThrow({ where: { id: leaf.id } })
    const current = await prisma.focusSession.findFirstOrThrow({ where: { userId: user.id } })
    if (winner === 'delete') { expect(task.status).toBe('dropped'); expect(current.taskId).toBeNull() }
    else { expect(task.status).toBe('active'); expect(current.taskId).toBe(leaf.id) }
  })
  it.each(['delete', 'split'] as const)('fences a delayed LLM breakdown when %s wins', async winner => {
    let entered!: () => void
    const ready = new Promise<void>(r => { entered = r })
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    const bot = makeBot({ llm: { enabled: true, model: 'test', async complete() {
      entered(); await gate
      return { text: JSON.stringify({ steps: ['Открыть файл', 'Написать текст'] }), usage: null }
    } } })
    await bot.setupOnboarded(A)
    let user = await prisma.user.findUniqueOrThrow({ where: { tgId: BigInt(A) } })
    const root = await prisma.task.create({ data: { userId: user.id, title: 'Родитель' } })
    user = await prisma.user.update({ where: { id: user.id }, data: { pendingInput: `task_split:${root.id}` } })
    const pending = onTaskBreakdownAnswer(bot.ctx, user, root.id, null, 'text')
    await ready
    if (winner === 'delete') await onTaskDropped(bot.ctx, user, root.id)
    release()
    await pending
    if (winner === 'split') await onTaskDropped(bot.ctx, user, root.id)
    expect(await prisma.task.count({ where: { userId: user.id, status: 'active' } })).toBe(0)
    expect(await prisma.task.count({ where: { userId: user.id, parentId: root.id } })).toBe(winner === 'delete' ? 0 : 2)
  })

})
