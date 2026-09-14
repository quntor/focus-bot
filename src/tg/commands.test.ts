import { describe, expect, it } from 'vitest'
import { parseCommand, parseSource } from './commands.js'

describe('parseCommand', () => {
  it('разбирает команду с аргументами', () => {
    expect(parseCommand('/focus дописать главу')).toEqual({ command: 'focus', args: 'дописать главу' })
  })

  it('срезает имя бота', () => {
    expect(parseCommand('/start@focus_naparnik_bot nn_chat')).toEqual({ command: 'start', args: 'nn_chat' })
  })

  it('не считает командой обычный текст', () => {
    expect(parseCommand('надо дописать главу')).toBeNull()
    expect(parseCommand('')).toBeNull()
    expect(parseCommand(undefined)).toBeNull()
  })

  it('приводит команду к нижнему регистру и терпит лишние пробелы', () => {
    expect(parseCommand('  /FOCUS   глава  ')).toEqual({ command: 'focus', args: 'глава' })
  })
})

describe('parseSource', () => {
  it('берёт метку из deep link', () => {
    expect(parseSource('nn_chat')).toBe('nn_chat')
    expect(parseSource('VK-Students extra')).toBe('vk-students')
  })

  it('отбрасывает мусор', () => {
    expect(parseSource('')).toBeNull()
    expect(parseSource('привет')).toBeNull()
    expect(parseSource('a'.repeat(40))).toBeNull()
  })
})
