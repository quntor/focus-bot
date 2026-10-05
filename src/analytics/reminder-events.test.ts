import { describe, expect, it } from 'vitest'
import { isUserAction } from './events.js'
import { PAYLOADS } from './payloads.js'

const slot = {
  chain_id: 'e52693e5-d586-4dcf-95cc-eb0d4305d15f',
  outbox_id: '310e4d31-8a41-4e09-bb39-c14952f188ce',
  kind: 'work', revision: 2, ordinal: 3,
}

describe('privacy-safe reminder events', () => {
  it('does not inflate DAU with proactive generations, deliveries or chain maintenance', () => {
    expect(isUserAction('reminder_generated')).toBe(false)
    expect(isUserAction('reminder_delivery')).toBe(false)
    expect(isUserAction('reminder_chain_changed')).toBe(false)
    expect(isUserAction('reminder_answered')).toBe(true)
  })
  it('accepts reminder fallback stage and distinguishes unknown generation from actual failures', () => {
    expect(PAYLOADS.llm_fallback.safeParse({ stage: 'reminder_text', reason: 'invalid' }).success).toBe(true)
    expect(PAYLOADS.reminder_generated.safeParse({ ...slot, provenance: 'fallback', llm_reason: 'uncertain' }).success).toBe(true)
    expect(PAYLOADS.reminder_generated.safeParse({ ...slot, provenance: 'llm', llm_reason: null }).success).toBe(true)
  })
  it('records due, delivery anchor and lag as numeric metadata only', () => {
    const data = { ...slot, status: 'uncertain', due_ms: 1000, anchor_ms: 2000, due_lag_ms: 1000 }
    expect(PAYLOADS.reminder_delivery.safeParse(data).success).toBe(true)
    expect(PAYLOADS.reminder_delivery.safeParse({ ...data, generated_text: 'private task' }).success).toBe(false)
    expect(PAYLOADS.reminder_delivery.safeParse({ ...data, status: 'arbitrary text' }).success).toBe(false)
    expect(PAYLOADS.reminder_delivery.safeParse({ ...data, kind: 'private task' }).success).toBe(false)
    expect(PAYLOADS.reminder_delivery.safeParse({ ...data, due_lag_ms: -1 }).success).toBe(false)
  })
})
