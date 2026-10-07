import { expect, vi } from 'vitest'
import type { LlmProvider, LlmRequest } from '../llm/provider.js'

// Explicit test replies, never a keyword classifier or a fallback interpreter.
// A test chooses the payload; the production ingress validates and executes it.
export function scriptedModel() {
  const replies: { text: string; response: object }[] = []
  const complete = vi.fn(async (request: LlmRequest) => {
    const expected = replies.shift()
    if (!expected) throw new Error('unexpected model call')
    expect(JSON.parse(request.input).text).toBe(expected.text)
    return { text: JSON.stringify(expected.response), usage: null }
  })
  const provider: LlmProvider = { enabled: true, model: 'scripted-test', complete }
  return { provider, complete,
    enqueue(text: string, response: object) { replies.push({ text, response }) },
    assertConsumed() { expect(replies).toHaveLength(0) },
  }
}
export const control = (text: string, action: string, value: string | null = null) => ({ route: 'control', text, action, value, followUp: null })
export const work = (text: string, title: string, minutes: number | null = null, durationSource: string | null = null, task: string | null = null) => ({ route: 'new_task', text, intent: { task, title, scope: 'step' }, minutes, durationSource, followUp: null })
export const rest = (text: string, minutes: number | null = null, durationSource: string | null = null) => ({ route: 'break', text, minutes, durationSource, followUp: null })
export const pending = (text: string, answer: object) => ({ route: 'answer_pending', text, answer, followUp: null })
