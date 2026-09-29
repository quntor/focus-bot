import { describe, expect, it } from 'vitest'
import {
  clearConversationContext,
  recentConversationContext,
  rememberConversationContext,
  resetConversationContext,
} from './conversation-context.js'

describe('короткий контекст текущей сессии', () => {
  it('хранит только четыре последних события и обрезает длинный текст', () => {
    clearConversationContext()
    const now = new Date('2026-09-29T12:00:00Z')

    rememberConversationContext('u1', 'user', 'первое', now)
    rememberConversationContext('u1', 'assistant', 'второе', now)
    rememberConversationContext('u1', 'button', 'end:continue', now)
    rememberConversationContext('u1', 'user', 'четвёрто', now)
    rememberConversationContext('u1', 'assistant', `  ${'я'.repeat(400)}  `, now)

    const recent = recentConversationContext('u1', now)
    expect(recent).toHaveLength(4)
    expect(recent[0]).toEqual({ role: 'assistant', text: 'второе' })
    expect(recent.at(-1)?.text).toHaveLength(300)
  })

  it('не возвращает текущую или более позднюю реплику повторно', () => {
    clearConversationContext()
    const now = new Date('2026-09-29T12:00:00Z')
    rememberConversationContext('u2', 'assistant', 'С чего продолжишь?', now)
    const current = rememberConversationContext('u2', 'user', 'С этой задачи', now)
    rememberConversationContext('u2', 'user', 'Следующее сообщение', now)

    expect(recentConversationContext('u2', now, { beforeEventId: current })).toEqual([
      { role: 'assistant', text: 'С чего продолжишь?' },
    ])
  })

  it('сбрасывается при новой сессии и истекает через шесть часов', () => {
    clearConversationContext()
    const now = new Date('2026-09-29T12:00:00Z')
    rememberConversationContext('u3', 'user', 'старый контекст', now)
    expect(recentConversationContext('u3', new Date('2026-09-29T18:00:01Z'))).toEqual([])

    rememberConversationContext('u3', 'user', 'новый контекст', now)
    resetConversationContext('u3')
    expect(recentConversationContext('u3', now)).toEqual([])
  })
})
