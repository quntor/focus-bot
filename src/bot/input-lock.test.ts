import { describe, expect, it } from 'vitest'
import { beginInput, withUserInputLock } from './input-lock.js'
describe('transient arrival generation', () => {
  it('two arrivals before lock never rebase the old turn onto the new input', async () => {
    const old = beginInput('arrival-owner')
    const fresh = beginInput('arrival-owner')
    const handled: string[] = []
    await Promise.all([
      withUserInputLock('arrival-owner', async () => { if (old()) handled.push('old') }),
      withUserInputLock('arrival-owner', async () => { if (fresh()) handled.push('fresh') }),
    ])
    expect(handled).toEqual(['fresh'])
  })
  it('awaited release cannot change the captured input generation; other owners do not invalidate it', async () => {
    const current = beginInput('release-owner')
    beginInput('other-owner')
    expect(current()).toBe(true)
    await Promise.resolve().then(() => beginInput('release-owner'))
    expect(current()).toBe(false)
  })
})
