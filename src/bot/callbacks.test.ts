import { describe, expect, it } from 'vitest'
import { cb, parseCallback } from './callbacks.js'

describe('callback_data', () => {
  const id = '6f1c1f5e-1234-4abc-8def-000000000000'
  it('укладывается в 64 байта и разбирается обратно', () => {
    const data = cb('rest', id, 'day_end')
    expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64)
    expect(parseCallback(data)).toEqual({ action: 'rest', id, arg: 'day_end' })
  })
  it('отвергает подделки: неизвестное действие, не-uuid, лишние части, мусор в аргументе', () => {
    expect(parseCallback('admin::grant')).toBeNull()
    expect(parseCallback('out:1:done')).toBeNull()
    expect(parseCallback(`out:${id}:done:extra`)).toBeNull()
    expect(parseCallback(`out:${id}:DROP TABLE`)).toBeNull()
    expect(parseCallback('x'.repeat(65))).toBeNull()
    expect(parseCallback(undefined)).toBeNull()
  })
})
