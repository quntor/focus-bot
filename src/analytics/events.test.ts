import { describe, expect, it } from 'vitest'
import { BOT_EVENTS, EVENT_TYPES, USER_ACTIONS, isUserAction } from './events.js'

describe('классификация событий', () => {
  it('исходящие бота обращениями не считаются', () => {
    expect(isUserAction('ping_sent')).toBe(false)
    expect(isUserAction('daily_summary_sent')).toBe(false)
    expect(isUserAction('points_awarded')).toBe(false)
  })

  it('засчитывает то, что сделал человек', () => {
    expect(isUserAction('session_started')).toBe(true)
    expect(isUserAction('ping_answered')).toBe(true)
    expect(isUserAction('daily_summary_confirmed')).toBe(true)
  })

  // Событие, забытое в обоих списках, молча уехало бы в «не обращение» и так же
  // молча занизило метрику. Здесь это падает сразу.
  it('каждый тип отнесён ровно к одной стороне', () => {
    const both = USER_ACTIONS.filter((type) => (BOT_EVENTS as readonly string[]).includes(type))
    expect(both).toEqual([])
    expect([...USER_ACTIONS, ...BOT_EVENTS].sort()).toEqual([...EVENT_TYPES].sort())
  })
})
