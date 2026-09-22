// Все тексты, которые видит пользователь, — в одном файле. Это черновики на
// согласование: формулировку правит человек, код от неё не зависит.
//
// Шаблоны закрывают всё, кроме двух касаний, где работает модель (разбор
// намерения и отчёта): пинг, конец сессии, отдых, встречи и служебные ответы
// не должны стоить обращения к модели.

import type { Outcome } from '../session/fsm.js'

export const hhmm = (d: Date, timezone: string) =>
  new Intl.DateTimeFormat('ru-RU', { timeZone: timezone, hour: '2-digit', minute: '2-digit' }).format(d)

const plural = (n: number, one: string, few: string, many: string) => {
  const m10 = n % 10
  const m100 = n % 100
  if (m10 === 1 && m100 !== 11) return one
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few
  return many
}

export const minutesText = (n: number) => {
  if (n === 60) return 'час'
  if (n === 90) return 'полтора часа'
  if (n % 60 === 0) return `${n / 60} ${plural(n / 60, 'час', 'часа', 'часов')}`
  return `${n} ${plural(n, 'минута', 'минуты', 'минут')}`
}

// Винительный падеж для «давай N минут работы».
const minutesAcc = (n: number) => {
  if (n === 60) return 'час'
  if (n === 90) return 'полтора часа'
  if (n % 60 === 0) return `${n / 60} ${plural(n / 60, 'час', 'часа', 'часов')}`
  return `${n} ${plural(n, 'минуту', 'минуты', 'минут')}`
}

export const T = {
  // --- Знакомство и согласие.
  // ТЕКСТ СОГЛАСИЯ ПИШЕТ ЧЕЛОВЕК. Здесь заглушка: до замены в бой не выкатывать.
  consent: (policyUrl: string | undefined) =>
    [
      'Привет! Я напарник по фокус-сессиям: сижу рядом, пока ты работаешь.',
      '',
      '[ЗАГЛУШКА: текст согласия на обработку персональных данных по 152-ФЗ — напишет человек]',
      policyUrl ? `Политика обработки данных: ${policyUrl}` : '[ЗАГЛУШКА: ссылка на политику]',
    ].join('\n'),
  consentButton: 'Согласен',
  consentRequired: 'Чтобы начать, нужно согласие на обработку данных — оно в сообщении выше. Удалить всё о себе можно командой /delete_me.',

  askTimezone: 'Сколько у тебя сейчас времени? Напиши, например, 14:30 — так я не перепутаю твои сутки.',
  badTimezone: 'Не понял время. Напиши часы и минуты, например 9:05 или 21:40.',
  timezoneSet: (time: string) => `Понял, у тебя ${time}.`,

  askRitual:
    'Что ты обычно делаешь перед тем, как сесть? Два-три действия одной строкой — например, «чай, закрыть вкладки, телефон в другую комнату». Буду напоминать перед стартом.',
  skip: 'Пропустить',
  ritualSaved: 'Записал ритуал.',

  welcomeBack: 'С возвращением.',

  // --- Старт сессии. «С чего начнёшь», а не «над чем работаешь»: условная
  // формулировка указывает на конкретную точку входа.
  askIntent: (ritual: string | null, hint: string | null) =>
    [ritual ? `Ритуал: ${ritual}.` : null, hint, 'С чего начнёшь?'].filter(Boolean).join('\n'),
  nextStepHint: (task: string, step: string) => `В прошлый раз по «${task}» следующим шагом было: ${step}.`,
  askContinue: 'С чего продолжишь?',

  bigIntent: (minutes: number | null) =>
    minutes ? `Это на несколько заходов. С чего начнёшь в эти ${minutesText(minutes)}?` : 'Это на несколько заходов. С чего начнёшь сейчас?',

  propose: (minutes: number, rest: number) => `Давай ${minutesAcc(minutes)} работы, потом ${rest} отдыха.`,
  proposeFree: 'Работаем без таймера: проверюсь раз в полчаса, закончишь — нажми /done.',
  proposeTechnique: (minutes: number, rest: number) => `${minutesText(minutes)} работы, ${rest} отдыха — как договаривались.`,
  ok: 'Ок',
  shorter: 'Короче',
  longer: 'Длиннее',
  cancel: 'Отмена',

  started: (minutes: number | null, rest: number, end: string | null) =>
    minutes && end
      ? `${capital(minutesText(minutes))} работы, потом ${rest} отдыха. Поехали — напишу в ${end}.`
      : 'Поехали. Закончишь — /done.',
  cancelled: 'Отменил. Напиши, когда будешь готов.',
  alreadyRunning: (end: string | null) =>
    end ? `Сессия идёт до ${end}. Закончить раньше — /done, бросить — /stop.` : 'Сессия идёт. Закончить — /done, бросить — /stop.',
  stopped: 'Остановил. Бывает — вернёмся, когда сможешь.',
  nothingRunning: 'Сейчас сессии нет. Напиши, с чего начнёшь.',

  // --- Пинг: шаблон, без модели.
  ping: 'На месте?',
  pingHere: 'Да',
  pingBack: 'Отвлёкся, возвращаюсь',
  pingAnsweredHere: 'Отлично, продолжаем.',
  pingAnsweredBack: 'Бывает. Возвращайся к делу — я тут.',

  // --- Конец и отчёт. Исход троичный.
  sessionEnd: 'Время! Как прошло?',
  sessionEndEarly: 'Как прошло?',
  outcome: { done: 'Сделал', not_done: 'Не сделал', other: 'Вышло другое' } satisfies Record<Outcome, string>,
  askReport: 'Пара слов — что вышло? Можно пропустить.',
  stuck: (task: string) => `По «${task}» уже третья сессия без сдвига. Давай в следующий раз возьмём шаг поменьше — какой самый маленький кусок можно закончить?`,

  // --- Отдых: спрашиваем, а не назначаем.
  askRest: (rest: number) => `Записал. Отдохнёшь ${rest} минут?`,
  restOk: (rest: number) => `Отдохну ${rest}`,
  restContinue: 'Сразу дальше',
  restLater: 'Вернусь позже',
  dayEnd: 'На сегодня всё',
  restStarted: (end: string) => `Отдыхай. Напишу в ${end}.`,
  restOver: 'Отдохнул? С чего продолжишь?',
  postpone: 'Ещё отдохну',
  postponed: (at: string) => `Хорошо, напишу в ${at}.`,

  // --- Встречи.
  askLater: 'Во сколько напомнить?',
  inHour: 'Через час',
  inTwoHours: 'Через 2 часа',
  evening: 'Вечером',
  customTime: 'Своё время',
  askCustomTime: 'Напиши время, например 18:30.',
  meetingSet: (at: string, day: 'today' | 'tomorrow') => `Договорились: ${day === 'today' ? 'сегодня' : 'завтра'} в ${at}.`,
  meetingMorning: 'Доброе утро. Сколько заходов сегодня?',
  meetingPlain: 'Привет! С чего начнёшь?',
  later: 'Позже',
  askNextMeeting: 'Когда встретимся в следующий раз?',
  tomorrowAt: (at: string) => `Завтра в ${at}`,

  // --- Третий отказ подряд: спросить вслух.
  declineCheck: 'Третий раз откладываем. Хочешь паузу или не получается начать?',
  wantPause: 'Паузу до завтра',
  cantStart: 'Не получается начать',
  tinyStep: 'Давай с самого маленького: 10 минут, любое действие по задаче. С чего начнёшь?',
  pauseSet: (at: string) => `Отдыхай. Напишу завтра в ${at}.`,

  // --- День.
  goalSet: (n: number) => `Цель на сегодня — ${n} ${plural(n, 'заход', 'захода', 'заходов')}. С чего начнёшь?`,
  askGoal: 'Сколько заходов сегодня?',
  goalReached: 'Цель дня выполнена!',
  summary: (s: DaySummary) =>
    [
      s.sessions === 0
        ? 'Сегодня сессий не было — бывает.'
        : `За сегодня: ${s.sessions} ${plural(s.sessions, 'сессия', 'сессии', 'сессий')}` +
          ` (сделал — ${s.done}, не сделал — ${s.notDone}, вышло другое — ${s.other}).`,
      s.target ? `Цель: ${s.counted} из ${s.target}.` : null,
      s.abandoned > 0 ? `Брошено: ${s.abandoned}.` : null,
      `Серия: ${s.streak} ${plural(s.streak, 'день', 'дня', 'дней')}. Очки за сегодня: ${s.points}.`,
    ]
      .filter(Boolean)
      .join('\n'),
  closeDay: 'Закрыть день',
  dayClosed: 'День закрыт.',

  // --- Настройки и профиль.
  settings: (s: { technique: string; pings: boolean; proactive: boolean; morning: string; timezone: string }) =>
    [
      'Настройки:',
      `Техника: ${TECHNIQUE_NAMES[s.technique] ?? s.technique}`,
      `Пинги в середине: ${s.pings ? 'да' : 'нет'}`,
      `Пишу первым: ${s.proactive ? 'да' : 'нет'}`,
      `Утро: ${s.morning}, пояс: ${s.timezone}`,
    ].join('\n'),
  setTechnique: 'Техника',
  togglePings: 'Пинги вкл/выкл',
  toggleProactive: 'Писать первым вкл/выкл',
  setMorning: 'Время утра',
  setTimezone: 'Часовой пояс',
  techniques:
    'Как работать:\n' +
    '• Помодоро — 25 минут работы, 5 отдыха, без пинга.\n' +
    '• Средний блок — 50 и 10, пинг в середине.\n' +
    '• Длинный блок — 90 и 20, для задач, где долго входишь в работу.\n' +
    '• Свободный — без таймера, проверяюсь раз в полчаса.\n' +
    '• Сам подберу — по тому, как у тебя идёт.',
  saved: 'Сохранил.',
  askMorning: 'Во сколько писать утром? Например, 9:30.',

  profile: (profile: string | null, ritual: string | null) =>
    [
      'Что я о тебе помню:',
      profile ? profile : '— пока ничего.',
      '',
      `Ритуал: ${ritual ?? 'не задан'}.`,
    ].join('\n'),
  editProfile: 'Изменить профиль',
  clearProfile: 'Очистить',
  editRitual: 'Изменить ритуал',
  askProfile: 'Напиши, что мне стоит о тебе помнить — заменю этим текстом то, что есть.',

  // --- Удаление.
  confirmDelete: 'Удалить все твои данные: задачи, сессии, отчёты, настройки? Это необратимо.',
  deleteYes: 'Удалить всё',
  deleted: 'Готово, всё удалено. Если захочешь вернуться — /start.',

  help:
    'Просто напиши, с чего начнёшь, — я засеку время.\n' +
    '/focus — начать сессию\n/done — закончить раньше\n/stop — бросить сессию\n' +
    '/today — на сегодня всё\n/goal — цель на день\n/settings — настройки\n' +
    '/profile — что я о тебе помню\n/delete_me — удалить все данные',

  // Ошибка наружу — общая фраза; подробности только во внутреннем логе.
  error: 'Что-то пошло не так. Попробуй ещё раз чуть позже.',
  stale: 'Это уже неактуально.',
  tooFast: 'Слишком быстро — подожди минуту.',
} as const

export type DaySummary = {
  sessions: number
  done: number
  notDone: number
  other: number
  abandoned: number
  counted: number
  target: number | null
  streak: number
  points: number
}

const TECHNIQUE_NAMES: Record<string, string> = {
  auto: 'сам подберу',
  pomodoro: 'помодоро 25/5',
  medium: 'средний блок 50/10',
  long: 'длинный блок 90/20',
  free: 'свободный',
}

function capital(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}
