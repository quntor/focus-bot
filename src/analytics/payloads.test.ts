import { describe, expect, it } from 'vitest'
import type { z } from 'zod'
import { EVENT_TYPES } from './events.js'
import { PAYLOADS } from './payloads.js'

const SENSITIVE = [
  'Написать Кате про увольнение',
  'разобрать анализы',
  'finish client report',
  'a'.repeat(200),
]

describe('схема события', () => {
  it('есть у каждого типа', () => {
    for (const type of EVENT_TYPES) expect(PAYLOADS[type], type).toBeDefined()
  })

  it('не принимает лишних ключей — формулировку не подложить рядом', () => {
    for (const type of EVENT_TYPES) {
      const res = PAYLOADS[type].safeParse({ text: SENSITIVE[0] })
      expect(res.success, type).toBe(false)
    }
  })

  // Проверяем каждое поле по отдельности: ни одно не принимает свободный текст.
  // Строковые поля допустимы только с форматом — uuid, ключ дня, метка, enum.
  it('ни одно поле не принимает свободный текст', () => {
    for (const type of EVENT_TYPES) {
      const shape = (PAYLOADS[type] as unknown as z.ZodObject).shape as Record<string, z.ZodType>
      for (const [key, field] of Object.entries(shape)) {
        for (const text of SENSITIVE) {
          expect(field.safeParse(text).success, `${type}.${key}`).toBe(false)
        }
      }
    }
  })
})
