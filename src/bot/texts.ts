// Все тексты, которые видит пользователь, — в одном файле. Это черновики на
// согласование: формулировку правит человек, код от неё не зависит.
//
// Шаблоны закрывают всё, кроме двух касаний, где работает модель (разбор
// намерения и отчёта): пинг, конец сессии, отдых, встречи и служебные ответы
// не должны стоить обращения к модели.
//
// Обращения к человеку — без грамматического рода: «Готово», а не «Сделал»,
// «Отдых закончился», а не «Отдохнул?». Пол не спрашиваем — это лишние
// персональные данные и лишний шаг знакомства.

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
  consentButton: 'Принимаю',
  consentRequired: 'Чтобы начать, нужно согласие на обработку данных — оно в сообщении выше. Удалить всё о себе можно командой /delete_me.',

  askTimezone: 'Сколько у тебя сейчас времени? Напиши, например, 14:30 — так я не перепутаю твои сутки.',
  badTimezone: 'Не понял время. Напиши часы и минуты, например 9:05 или 21:40.',
  timezoneSet: (time: string) => `Понял, у тебя ${time}.`,

  askRitual:
    'Что ты обычно делаешь перед тем, как сесть? Два-три действия одной строкой — например, «выпить кофе, включить музыку, удобно сесть». Буду напоминать перед стартом.',
  skip: 'Пропустить',
  ritualSaved: 'Записал ритуал.',

  welcomeBack: 'С возвращением.',

  sessionStartButton: 'Начать сессию',
  sessionBreakButton: 'Перерыв',
  sessionResumeButton: 'Вернуться к работе',
  sessionNewButton: 'Начать новую сессию',
  tasksButton: 'Мои задачи',

  // --- Список задач и голос.
  voiceTooLong: 'Голосовое должно быть не длиннее 3 минут.',
  voiceTooLarge: 'Голосовое слишком большое. Пришли запись до 5 МБ или напиши задачи текстом.',
  voiceDisabled: 'Распознавание голоса сейчас выключено. Напиши задачи текстом.',
  voiceRateLimited: 'За час можно разобрать до 5 голосовых. Следующие задачи пока пришли текстом.',
  voiceFailed: 'Не смог распознать голосовое. Попробуй ещё раз или напиши задачи текстом.',
  voiceTranscript: (text: string) => `Распознал: «${text.replace(/\s+/g, ' ').trim().slice(0, 500)}».`,
  tasksParseFailed: 'Не смог надёжно разобрать список. Напиши задачи отдельными пунктами или по одной.',
  tasksCaptured: (tasks: string[]) =>
    [`В списке ${tasks.length} ${plural(tasks.length, 'задача', 'задачи', 'задач')}:`, ...tasks.map((task, i) => `${i + 1}. ${task}`), '', 'Что берём сейчас?'].join('\n'),
  tasksEmpty: 'Активных задач пока нет. Надиктуй или напиши, что нужно сделать.',
  tasksChoose: 'Таймер уже идёт. Выбери задачу для этой сессии — отсчёт продолжится без перезапуска.',
  tasksList: (tasks: string[], page: number, pages: number, notice?: string) =>
    [
      notice,
      `Активные задачи${pages > 1 ? ` — страница ${page + 1} из ${pages}` : ''}:`,
      ...tasks.map((task, i) => `${page * 6 + i + 1}. ${task}`),
      '',
      '▶️ — начать сессию, 🗑 — убрать из списка.',
    ].filter(Boolean).join('\n'),
  taskDropped: (task: string) => `Убрал «${task}» из активных задач.`,
  taskRestored: (task: string) => `Вернул «${task}» в активные задачи.`,
  taskDropActive: 'Эта задача сейчас идёт в текущей сессии. Сначала закончи её или останови сессию.',
  taskRestoreButton: '↩️ Вернуть',
  taskSelectedRunning: (task: string, end: string | null) =>
    `Текущая сессия теперь по задаче «${task}». Таймер продолжает идти${end ? ` до ${end}` : ''}.`,
  taskSwitchMismatch: 'Не уверен, какую текущую задачу завершить. Назови её точнее — ничего пока не менял.',
  taskSwitchPaused: 'Сессия на перерыве. Сначала вернись к работе, затем напиши, что закончил и к чему переходишь.',
  taskSwitched: (done: string, next: string) => `«${done}» отметил готовой. Перехожу к «${next}».`,

  // --- Старт сессии. «С чего начнёшь», а не «над чем работаешь»: условная
  // формулировка указывает на конкретную точку входа.
  askIntent: (ritual: string | null, hint: string | null) =>
    [ritual ? `Ритуал: ${ritual}.` : null, hint, 'С чего начнёшь?'].filter(Boolean).join('\n'),
  nextStepHint: (task: string, step: string) => `В прошлый раз по «${task}» следующим шагом было: ${step}.`,
  askContinue: 'С чего продолжишь?',

  bigIntent: (minutes: number | null) =>
    minutes ? `Это на несколько заходов. С чего начнёшь в эти ${minutesText(minutes)}?` : 'Это на несколько заходов. С чего начнёшь сейчас?',

  propose: (minutes: number, rest: number) => `Давай ${minutesAcc(minutes)} работы, потом ${rest} отдыха.`,
  proposeFree: 'Работаем без таймера — загляну раз в полчаса. Когда закончишь, нажми /done.',
  proposeTechnique: (minutes: number, rest: number) => `${minutesText(minutes)} работы, ${rest} отдыха — как договаривались.`,
  ok: 'Ок',
  shorter: 'Короче',
  longer: 'Длиннее',
  cancel: 'Отмена',

  started: (minutes: number | null, rest: number, end: string | null, intent: string | null) => {
    const name = intent?.replace(/\s+/g, ' ').trim().slice(0, 80)
    const prefix = name ? `Сессия «${name}» началась.` : 'Сессия началась.'
    return minutes && end
      ? `${prefix} ${capital(minutesText(minutes))} работы, потом ${rest} отдыха. Поехали — напишу в ${end}.`
      : `${prefix} Работаем без таймера. Закончишь — /done.`
  },
  changeRunningWork: 'Изменить работу',
  changeRunningDuration: 'Изменить длительность',
  askRunningWork: 'Что меняем в текущей работе? Напиши новую формулировку.',
  askRunningDuration: 'Сколько должна длиться вся сессия? Напиши, например: 25 минут.',
  badRunningDuration: 'Не понял длительность. Напиши, например: 25 минут или 1 час.',
  runningDurationTooShort: (elapsed: number) =>
    `Уже прошло ${elapsed} ${plural(elapsed, 'минута', 'минуты', 'минут')}. Укажи общую длительность больше.`,
  runningWorkUpdated: (intent: string) => `Работу изменил на «${intent.replace(/\s+/g, ' ').trim().slice(0, 80)}». Таймер продолжается.`,
  runningDurationUpdated: (minutes: number, end: string) =>
    `Длительность изменил: ${minutesText(minutes)}. Новое время окончания — ${end}.`,
  cancelled: 'Отменил. Напиши, когда будет удобно.',
  alreadyRunning: (end: string | null) =>
    end ? `Сессия идёт до ${end}. Закончить раньше — /done, бросить — /stop.` : 'Сессия идёт. Закончить — /done, бросить — /stop.',
  stopped: 'Остановил. Бывает — вернёмся, когда сможешь.',
  nothingRunning: 'Сейчас сессии нет. Напиши, с чего начнёшь.',
  breakStarted: 'Хорошо, отвлекись. Таймер остановлен.',
  breakChoice: 'Ты на перерыве. Вернуться к прежней задаче или начать новую сессию?',
  breakResumed: (end: string | null) => (end ? `Продолжаем. Новое время окончания — ${end}.` : 'Продолжаем.'),
  nothingToPause: 'Сессия ещё не идёт — ставить на паузу нечего.',
  nothingPaused: 'Сейчас нет сессии на перерыве.',

  // --- Пинг: шаблон, без модели.
  ping: 'На месте?',
  pingHere: 'Да, работаю',
  pingBack: 'Возвращаюсь к делу',
  pingAnsweredHere: 'Отлично, продолжаем.',
  pingAnsweredBack: 'Бывает. Я тут — продолжаем.',

  // --- Конец и отчёт. Исход троичный.
  sessionEnd: 'Время! Как прошло?',
  sessionEndEarly: 'Как прошло?',
  outcome: { done: 'Готово', not_done: 'Пока не готово', other: 'Ушло в другое' } satisfies Record<Outcome, string>,
  askReport: 'Пара слов — что вышло? Можно пропустить.',
  stuck: (task: string) => `По «${task}» уже третья сессия без сдвига. Давай в следующий раз возьмём шаг поменьше — какой самый маленький кусок можно закончить?`,

  // --- Отдых: спрашиваем, а не назначаем.
  askRest: (rest: number) => `Записал. Отдохнёшь ${rest} минут?`,
  restOk: (rest: number) => `Отдохну ${rest}`,
  restContinue: 'Ещё поработаем',
  restLater: 'Вернусь позже',
  dayEnd: 'На сегодня всё',
  restStarted: (end: string) => `Отдыхай. Напишу в ${end}.`,
  restOver: 'Отдых закончился. С чего продолжишь?',
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
  // Начало недели — естественный новый старт (Dai, Milkman, Riis, 2014).
  meetingMonday: 'Новая неделя. Сколько заходов сегодня?',
  meetingPlain: 'Привет! С чего начнёшь?',
  later: 'Позже',
  askNextMeeting: 'Когда встретимся в следующий раз?',
  tomorrowAt: (at: string) => `Завтра в ${at}`,
  dayOffButton: 'Завтра выходной',
  dayOffSet: (at: string) => `Завтра выходной — серия не прервётся. Напишу послезавтра в ${at}.`,
  dayOffTaken: 'На этой неделе выходной уже был — следующий можно взять с понедельника.',

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
  // Прогресс к цели после каждой сессии: чем ближе цель, тем сильнее тянет её
  // закрыть (эффект приближения к цели, Kivetz et al., 2006).
  goalProgress: (done: number, target: number) => {
    const left = target - done
    return `${done} из ${target} — ${left === 1 ? 'остался один заход' : `осталось ${left} ${plural(left, 'заход', 'захода', 'заходов')}`}.`
  },
  // Заморозка — запас на срыв, и работает он, когда его видно (Sharif & Shu, 2021).
  freezeUsed: (days: number, left: number) =>
    (days === 1 ? 'Вчера был пропуск — закрыл его заморозкой' : `Пропущено ${days} ${plural(days, 'день', 'дня', 'дней')} — закрыл заморозками`) +
    `, ${left === 1 ? 'осталась 1' : `осталось ${left}`}.`,
  // Разрыв — без вины и с выходом: показанная прерванная серия снижает
  // вовлечённость, возможность починить этот эффект ослабляет.
  streakBroken: (previous: number, repairable: boolean) =>
    repairable
      ? `Серия в ${previous} ${plural(previous, 'день', 'дня', 'дней')} прервалась — не страшно. Два захода за день в ближайшие три дня — и я её верну.`
      : 'Начинаем новую серию — сегодня первый день.',
  streakRepaired: (n: number) => `Серия восстановлена: ${n} ${plural(n, 'день', 'дня', 'дней')}.`,
  comeback: 'С возвращением!',
  summary: (s: DaySummary) =>
    [
      s.sessions === 0
        ? 'Сегодня сессий не было — бывает.'
        : `За сегодня: ${s.sessions} ${plural(s.sessions, 'сессия', 'сессии', 'сессий')}` +
          outcomesLine(s),
      s.target ? `Цель: ${s.counted} из ${s.target}.` : null,
      s.abandoned > 0 ? `Брошено: ${s.abandoned}.` : null,
      `Серия: ${s.streak} ${plural(s.streak, 'день', 'дня', 'дней')}. Очки за сегодня: ${s.points}.`,
      weekLine(s),
      `Активных дней за последние 7: ${s.activeDays} из 7.`,
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
      `Утро: ${s.morning}, пояс: ${zoneName(s.timezone)}`,
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
    '• Свободный — без таймера, загляну раз в полчаса.\n' +
    '• Сам подберу — по тому, как у тебя идёт.',
  saved: 'Сохранил.',
  suggestLong: 'Ты стабильно просишь продлить — похоже, тебе подходят длинные блоки: 90 минут работы и 20 отдыха. Попробуем так?',
  suggestShort: 'Давай короче: 25 минут работы и 5 отдыха — легче начать. Попробуем?',
  tryIt: 'Попробуем',
  keepAsIs: 'Оставить как есть',
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
    '/focus — начать сессию\n/tasks — мои задачи\n/done — закончить раньше\n/stop — бросить сессию\n' +
    '/today — на сегодня всё\n/goal — цель на день\n/dayoff — завтра выходной\n/settings — настройки\n' +
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
  weekPoints: number
  // Очки прошлой недели к тому же дню недели; null — прошлой недели не было.
  prevWeekPoints: number | null
  bestWeek: boolean
  activeDays: number
}

// Очки — сведения о прогрессе, а не плата и не угроза: сравнение с собой же
// неделю назад, без лидербордов (Deci, Koestner, Ryan, 1999).
function weekLine(s: DaySummary): string {
  const base = `За неделю: ${s.weekPoints} ${plural(s.weekPoints, 'очко', 'очка', 'очков')}`
  let tail = '.'
  if (s.prevWeekPoints !== null && s.prevWeekPoints > 0) {
    tail =
      s.weekPoints >= s.prevWeekPoints
        ? ` — на ${s.weekPoints - s.prevWeekPoints} больше, чем к этому дню прошлой недели.`
        : ` — к этому дню прошлой недели было ${s.prevWeekPoints}.`
  }
  return base + tail + (s.bestWeek ? ' Лучшая неделя!' : '')
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

// Нулевые исходы не показываем: «ушло в другое — 0» — шум.
function outcomesLine(s: DaySummary): string {
  const parts = [
    s.done ? `готово — ${s.done}` : null,
    s.notDone ? `пока не готово — ${s.notDone}` : null,
    s.other ? `ушло в другое — ${s.other}` : null,
  ].filter(Boolean)
  return parts.length ? ` (${parts.join(', ')}).` : '.'
}

// Российские пояса — по-русски, остальные — кодом.
const ZONE_NAMES: Record<string, string> = {
  'Europe/Kaliningrad': 'Калининград',
  'Europe/Moscow': 'Москва',
  'Europe/Samara': 'Самара',
  'Asia/Yekaterinburg': 'Екатеринбург',
  'Asia/Omsk': 'Омск',
  'Asia/Krasnoyarsk': 'Красноярск',
  'Asia/Irkutsk': 'Иркутск',
  'Asia/Yakutsk': 'Якутск',
  'Asia/Vladivostok': 'Владивосток',
  'Asia/Magadan': 'Магадан',
  'Asia/Kamchatka': 'Камчатка',
}
export const zoneName = (tz: string) => ZONE_NAMES[tz] ?? tz
