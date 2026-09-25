import { describe, expect, it } from 'vitest'
import { adjust, parseNamedMinutes, proposeMinutes, restFor, type PastSession } from './duration.js'
import { canTransition, IllegalTransition, STATES } from './fsm.js'

describe('названная длительность', () => {
  it.each([
    ['допишу раздел, за час', 60],
    ['полчаса на почту', 30],
    ['полтора часа код', 90],
    ['40 минут на статью', 40],
    ['минут 20 посижу', 20],
    ['2 часа диплом', 120],
    ['1,5 часа', 90],
    ['1 час 30 минут', 90],
    ['три часа', 180],
    ['сяду на 5 часов', 240],
    ['25 мин', 25],
  ])('«%s» → %i', (text, minutes) => {
    expect(parseNamedMinutes(text)).toBe(minutes)
  })

  it.each(['написать Кате', 'к трём часам отчёт', 'в 15:00 созвон', 'просто посидеть', 'часы починить'])('«%s» — время не названо', (text) => {
    expect(parseNamedMinutes(text)).toBeNull()
  })
})

const s = (over: Partial<PastSession>): PastSession => ({ state: 'finished', plannedMinutes: 40, counted: true, minutesAdjusted: null, restChoice: null, ...over })

describe('предложение длины', () => {
  it('без истории — 40', () => expect(proposeMinutes([])).toBe(40))
  it('две брошенные подряд — короче', () => expect(proposeMinutes([s({ state: 'abandoned', counted: false }), s({ state: 'abandoned', counted: false })])).toBe(30))
  it('трижды досидел и просил ещё — длиннее', () => expect(proposeMinutes([s({ minutesAdjusted: 'up' }), s({ restChoice: 'continue' }), s({ minutesAdjusted: 'up' })])).toBe(50))
  it('в рамках 15–90', () => {
    expect(proposeMinutes([s({ plannedMinutes: 200, minutesAdjusted: 'up' }), s({ plannedMinutes: 200, minutesAdjusted: 'up' }), s({ plannedMinutes: 200, minutesAdjusted: 'up' })])).toBe(90)
    expect(proposeMinutes([s({ plannedMinutes: 10, state: 'abandoned' }), s({ plannedMinutes: 10, state: 'abandoned' })])).toBe(15)
  })
  it('кнопки двигают на 10 в границах 5–240', () => {
    expect(adjust(40, 'up')).toBe(50)
    expect(adjust(10, 'down')).toBe(5)
    expect(adjust(240, 'up')).toBe(240)
  })
  it('отдых по длине сессии', () => {
    expect([restFor(25), restFor(40), restFor(90), restFor(120)]).toEqual([5, 10, 15, 20])
  })
})

describe('автомат сессии', () => {
  it('разрешены только переходы из схемы', () => {
    const allowed = STATES.flatMap((from) => STATES.filter((to) => canTransition(from, to)).map((to) => `${from}>${to}`))
    expect(allowed.sort()).toEqual([
      'collecting_intent>cancelled',
      'collecting_intent>running',
      'paused>abandoned',
      'paused>running',
      'running>abandoned',
      'running>finished',
      'running>paused',
    ])
  })
  it('abandoned и finished — конечные', () => {
    expect(canTransition('abandoned', 'finished')).toBe(false)
    expect(new IllegalTransition('abandoned', 'finished').name).toBe('IllegalTransition')
  })
})
