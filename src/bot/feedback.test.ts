import { beforeEach, describe, expect, it, vi } from 'vitest'
import { hasDb, prisma, resetDb } from '../test/db.js'
import { makeBot } from '../test/bot.js'
import { parseSemanticRoute } from '../llm/router.js'

describe('bot feedback boundary', () => {
  it('semantic feedback forbids actions and extra fields', async () => {
    const input = { text: 'Ответ не соответствует моей просьбе', pending: 'task_add', pendingAgeSeconds: 0, session: null, lastSession: null, lastQuestion: null, recentContext: [], tasks: [], allowedRoutes: ['feedback'] as const }
    for (const extra of [{}, { reply: 'anything' }, { followUp: { route: 'close_day', text: 'просьбе' } }]) {
      const complete = vi.fn(async () => ({ text: JSON.stringify({ route: 'feedback', text: input.text, followUp: null, ...extra }), usage: null }))
      const result = await parseSemanticRoute({ enabled: true, model: 'test', complete }, input)
      expect(result.ok).toBe(Object.keys(extra).length === 0)
    }
  })
})
