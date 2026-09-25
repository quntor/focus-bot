import { describe, expect, it } from 'vitest'
import { BOT_COMMANDS } from './menu.js'

describe('нативное меню Telegram', () => {
  it('показывает все пользовательские действия в понятном порядке', () => {
    expect(BOT_COMMANDS).toEqual([
      { command: 'focus', description: 'Начать фокус-сессию' },
      { command: 'tasks', description: 'Показать мои задачи' },
      { command: 'done', description: 'Закончить текущую сессию' },
      { command: 'stop', description: 'Бросить текущую сессию' },
      { command: 'goal', description: 'Задать цель на день' },
      { command: 'today', description: 'Завершить день и подвести итог' },
      { command: 'dayoff', description: 'Запланировать выходной на завтра' },
      { command: 'settings', description: 'Посмотреть и изменить настройки' },
      { command: 'profile', description: 'Посмотреть и изменить профиль' },
      { command: 'help', description: 'Показать справку' },
      { command: 'delete_me', description: 'Удалить все мои данные' },
    ])
  })

  it('соответствует ограничениям Bot API', () => {
    expect(new Set(BOT_COMMANDS.map(({ command }) => command)).size).toBe(BOT_COMMANDS.length)
    for (const { command, description } of BOT_COMMANDS) {
      expect(command).toMatch(/^[a-z0-9_]{1,32}$/)
      expect(description.length).toBeGreaterThanOrEqual(3)
      expect(description.length).toBeLessThanOrEqual(256)
    }
  })
})
