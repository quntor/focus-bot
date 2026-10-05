import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Prisma } from '@prisma/client'
import { hasDb, prisma, resetDb } from '../test/db.js'
import { makeBot } from '../test/bot.js'
import { sweepOnce } from './sweeper.js'

describe.skipIf(!hasDb)('legacy timeout snapshot races', () => {
  beforeEach(resetDb)
  afterEach(() => vi.restoreAllMocks())

  it.each(['running', 'paused'] as const)('does not close %s after enrollment or deadline renewal', async (state) => {
    for (const change of ['policy', 'deadline'] as const) {
      await resetDb()
      const bot = makeBot({ now: new Date('2026-10-05T12:00:00Z') })
      const user = await prisma.user.create({ data: { tgId: 962099n, proactive: false } })
      const session = await prisma.focusSession.create({ data: {
        userId: user.id, state, reminderPolicy: 0, plannedMinutes: 40,
        startedAt: new Date('2026-10-05T06:00:00Z'),
        plannedEndAt: new Date('2026-10-05T06:40:00Z'),
        pausedAt: state === 'paused' ? new Date('2026-10-05T07:00:00Z') : null,
      } })
      const original = prisma.focusSession.findMany.bind(prisma.focusSession)
      let changed = false
      const interleave = async (args?: Prisma.FocusSessionFindManyArgs) => {
        const rows = await original(args)
        if (!changed && args?.where?.state === state && args?.where?.reminderPolicy === 0) {
          changed = true
          await prisma.focusSession.update({ where: { id: session.id }, data: change === 'policy'
            ? { reminderPolicy: 1 }
            : state === 'running' ? { plannedEndAt: new Date('2026-10-05T12:40:00Z') }
              : { pausedAt: bot.ctx.now() } })
        }
        return rows
      }
      // The spy awaits a real Prisma query before the concurrent state change;
      // its test wrapper is a native Promise, not Prisma's lazy query promise.
      vi.spyOn(prisma.focusSession, 'findMany').mockImplementation(interleave as unknown as typeof prisma.focusSession.findMany)
      await sweepOnce(bot.ctx)
      expect(changed).toBe(true)
      expect((await prisma.focusSession.findUniqueOrThrow({ where: { id: session.id } })).state).toBe(state)
      expect(await prisma.event.count({ where: { sessionId: session.id, type: 'session_auto_finished' } })).toBe(0)
      expect(bot.tg.sent).toHaveLength(0)
      vi.restoreAllMocks()
    }
  })
})
