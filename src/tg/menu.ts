// Нативное меню Telegram у поля ввода. Команды ведут в те же обработчики, что
// и ручной ввод, поэтому у меню нет отдельной логики и отдельного состояния.
export const BOT_COMMANDS = [
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
] as const
