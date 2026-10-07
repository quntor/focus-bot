// Все тексты, которые видит пользователь, — в одном файле.
//
// Модель разбирает только пользовательский свободный текст и голос: намерение,
// команды по задачам и отчёт. Пинг, конец сессии, отдых, встречи и служебные
// ответы не должны стоить обращения к модели.
//
// Обращения к человеку — без грамматического рода: «Готово», а не «Сделал»,
// «Отдых закончился», а не «Отдохнул?». Пол не спрашиваем — это лишние
// персональные данные и лишний шаг знакомства.

import { GUIDE_URL } from '../lib/links.js'
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

const askTimezone = 'Сколько у тебя сейчас времени? Напиши, например, 14:30 — так я не перепутаю твои сутки.'

const onboardingGuide =
  'Быстрый старт:\n' +
  '• Нажми «Начать сессию» — таймер пойдёт сразу, а задачу можно выбрать позже.\n' +
  '• Напиши или надиктуй список дел одним сообщением — разберу его на задачи.\n' +
  '• Пиши естественно: «отвлекаюсь», «не получается» или «с этой всё, перехожу к другой» — предложу варианты и ничего не переключу без твоего подтверждения.\n\n' +
  'Как быстрее подстроить меня:\n' +
  '• После каждого захода коротко скажи, что получилось и что делать дальше — напомню следующий шаг.\n' +
  '• Если блок слишком короткий или длинный, нажми «Изменить длительность» под стартом; пинги и время меняются в /settings.\n' +
  '• В /profile запиши важные особенности работы — профиль меняется только по твоей команде.\n\n' +
  `Подробный гайд с примерами и картинками: ${GUIDE_URL}\n` +
  'Все возможности можно снова посмотреть в /help.'

export const DEADLINE_EXTEND_MINUTES = 15

export const T = {
  cannotInterpret: 'Не смог понять сообщение. Ничего не меняю. Попробуй ещё раз или используй кнопки.',
  feedback: 'Понял, ты недоволен ответом. Сессию, таймер и задачи не меняю.',
  // --- Знакомство.
  // Большинство пишет из московского пояса: подтверждение — одно нажатие,
  // остальные вводят время, как раньше.
  welcome: (moscowTime: string) =>
    ['Привет! Я напарник по фокус-сессиям: сижу рядом, пока ты работаешь.', '', `У тебя сейчас ${moscowTime}, как в Москве?`].join('\n'),
  timezoneYes: 'Да',
  timezoneNo: 'Нет, другое время',
  onboardingGuide,
  askTimezone,
  badTimezone: 'Не понял время. Напиши часы и минуты, например 9:05 или 21:40.',
  timezoneSet: (time: string) => `Понял, у тебя ${time}.`,

  // Время старта — это morningTime: в него приходит утреннее сообщение.
  askStartTime: 'Во сколько обычно садишься работать?',
  startTimeVaries: 'По-разному',
  askStartTimeCustom: 'Напиши время, например 9:30.',

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
  statusButton: 'Статус',
  statusIdle: 'Сейчас нет активной сессии или отдыха.',
  statusPreparing: 'Сессия ещё не началась: выбираем задачу и длительность.',
  statusNoTask: 'Задача не выбрана.',
  statusWork: 'Идёт рабочая сессия.',
  statusRest: 'Идёт отдых.',
  statusUnknownTime: 'Время начала не сохранено.',
  statusElapsed: (duration: string) => `Прошло: ${duration}.`,
  statusTask: (title: string, resting: boolean) => `${resting ? 'Последняя задача' : 'Задача'}: ${title}`,
  statusDeadlinePassed: 'Плановое время вышло; режим не изменён.',

  // --- Список задач и голос.
  voiceTooLong: 'Голосовое должно быть не длиннее 3 минут.',
  voiceTooLarge: 'Голосовое слишком большое. Пришли запись до 5 МБ или напиши задачи текстом.',
  voiceDisabled: 'Распознавание голоса сейчас выключено. Напиши задачи текстом.',
  voiceRateLimited: 'За час можно разобрать до 5 голосовых. Следующие задачи пока пришли текстом.',
  voiceFailed: 'Не смог распознать голосовое. Попробуй ещё раз или напиши задачи текстом.',
  voiceBudget: 'На сегодня распознавание голоса закончилось — напиши текстом.',
  voiceTranscript: (text: string) => `Распознал: «${text.replace(/\s+/g, ' ').trim().slice(0, 500)}».`,
  tasksParseFailed: 'Не понял. Напиши по-другому — одной задачей или списком, каждую с новой строки.',
  tasksCaptured: (tasks: string[]) =>
    [`В списке ${tasks.length} ${plural(tasks.length, 'задача', 'задачи', 'задач')}:`, ...tasks.map((task, i) => `${i + 1}. ${task}`), '', 'Что берём сейчас?'].join('\n'),
  tasksEmpty: 'Активных задач пока нет. Надиктуй или напиши, что нужно сделать.',
  tasksChoose: 'Таймер уже идёт. Если хочешь, выбери задачу — отсчёт продолжится без перезапуска.',
  tasksPick: 'Выбери, за что берёшься, — сразу запущу.',
  tasksList: (tasks: string[], page: number, pages: number, notice?: string) =>
    [
      notice,
      `Активные задачи${pages > 1 ? ` — страница ${page + 1} из ${pages}` : ''}:`,
      ...tasks.map((task, i) => `${page * 6 + i + 1}. ${task}`),
      '',
      'Напиши номер или нажми на задачу, чтобы выбрать действие.',
    ].filter(Boolean).join('\n'),
  tasksStartList: (tasks: string[], page: number, pages: number, prefix: string) => {
    const intro = prefix.replace(/\s*С чего начнёшь\?$/, '')
    const heading = `У тебя такие дела${pages > 1 ? ` — страница ${page + 1} из ${pages}` : ''}:`
    const lead = intro === 'Привет!' ? [`${intro} ${heading}`] : [intro, '', heading]
    return [...lead, ...tasks.map((task, i) => `${page * 6 + i + 1}. ${task}`), '', 'С чего начнёшь?'].join('\n')
  },
  taskActions: (task: string) => `Задача: «${task}»\n\nЧто сделать?`,
  taskBreakdownButton: '🧩 Разобрать',
  stepLabel: (step: string, n: number, total: number) => `↳ ${step} (шаг ${n} из ${total})`,
  allStepsDone: (task: string) => `Все шаги «${task}» готовы. Закрыть и саму задачу?`,
  closeParentButton: (task: string) => `✅ Закрыть «${task}»`,
  closeTaskButton: (task: string) => `✅ «${task}» готова целиком`,
  // Добавить задачу без старта сессии: отдельное название в свободном тексте
  // по-прежнему означает «начинаю» (решение 25.09).
  taskAddButton: '➕ Добавить задачу',
  taskAddAsk: 'Как назвать задачу? Можно сразу несколько — каждую с новой строки.',
  taskAdded: (task: string) => `Добавил «${task}».`,
  taskExists: (task: string) => `«${task}» уже есть в списке.`,
  tasksTrimmed: (n: number) => `Записал первые ${n} — остальное пришли следующим сообщением.`,
  // Сначала — как человек сам видит задачу: нюансы знает он.
  breakdownAsk: (task: string) =>
    `Как ты видишь задачу «${task}»? С чего хочется начать?\n\nМожно просто перечислить шаги — запишу как есть.`,
  breakdownAuto: 'Предложи сам',
  breakdownManual: 'Не смог разобрать сам. Напиши шаги, каждый с новой строки, — запишу.',
  breakdownFirstAction: 'Пока не вижу, как это разбить. Назови одно действие, с которого можно начать за 10 минут, — запишу первым шагом.',
  breakdownDone: (task: string, steps: string[]) =>
    [`Шаги по «${task}»:`, ...steps.map((step, i) => `${i + 1}. ${step}`), '', 'Начнём с первого?'].join('\n'),
  breakdownStartFirst: '▶️ Начать с первого',
  taskStartButton: '▶️ Начать',
  taskCompleteButton: '✅ Завершить',
  taskEditButton: '✏️ Изменить',
  taskDropButton: '🗑 Удалить с подзадачами',
  tasksBackButton: '← К списку',
  taskDropped: (task: string, children = 0) => `Убрал «${task}» и активные подзадачи (${children}). История работы сохранена.`,
  taskRestored: (task: string) => `Вернул «${task}» в активные задачи.`,
  taskDropActive: 'Нельзя убрать задачу: она или её подзадача идёт в текущей сессии. Сначала закончи её или останови сессию.',
  taskRestoreButton: '↩️ Отменить удаление',
  taskSelectedRunning: (task: string, end: string | null) =>
    `Текущая сессия теперь по задаче «${task}». Таймер продолжает идти${end ? ` до ${end}` : ''}.`,
  taskSwitchMismatch: 'Не уверен, какую текущую задачу завершить. Назови её точнее — ничего пока не менял.',
  taskSwitchNoCurrent: 'Сейчас нет текущей задачи, которую можно отметить готовой. Назови, с чего начать.',
  taskSwitchPaused: 'Сессия на перерыве. Сначала вернись к работе, затем напиши, что готово и к чему переходишь.',
  taskSwitched: (done: string, next: string) => `«${done}» отметил готовой. Перехожу к «${next}».`,
  taskSwitchedRunning: (done: string, next: string) => `«${done}» отметил готовой. Перехожу к «${next}». Таймер продолжает идти.`,
  taskCompleted: (task: string) => `«${task}» отметил готовой.`,
  // Закрытие задачи сессию не заканчивает (решение 01.10): её заканчивают
  // таймер, /done, «Пора отдыхать» и /stop.
  taskDoneTimerRuns: (task: string, end: string | null) =>
    `«${task}» отметил готовой. Таймер идёт дальше${end ? ` до ${end}` : ''} — берём следующий шаг.`,
  taskDoneTimerRunsEmpty: 'Напиши, за что берёшься дальше, или нажми /done, если на этом всё.',
  taskCompleteUnknown: 'Не понял, какую задачу отметить готовой. Назови её точнее или выбери в «Мои задачи».',
  taskEditAsk: (task: string) => `Напиши новое название для задачи «${task}».`,
  taskEditInvalid: 'Название не может быть пустым. Напиши новое название задачи.',
  taskEditDuplicate: 'Такая активная задача уже есть. Напиши другое название.',
  taskRenamed: (task: string) => `Переименовал задачу: «${task}».`,

  // --- Старт сессии. «С чего начнёшь», а не «над чем работаешь»: условная
  // формулировка указывает на конкретную точку входа.
  askIntent: (ritual: string | null, hint: string | null) =>
    [ritual ? `Ритуал: ${ritual}.` : null, hint, 'С чего начнёшь?'].filter(Boolean).join('\n'),
  nextStepHint: (task: string, step: string) => `В прошлый раз по «${task}» следующим шагом было: ${step}.`,
  askContinue: 'С чего продолжишь?',

  bigIntent: (minutes: number | null) =>
    minutes ? `Это на несколько заходов — задачу записал. С чего начнёшь на ${minutesAcc(minutes)}?` : 'Это на несколько заходов — задачу записал. С чего начнёшь сейчас?',

  propose: (minutes: number, rest: number) => `Давай ${minutesAcc(minutes)} работы, потом ${rest} отдыха.`,
  // Предложение, а не старт: таймер пойдёт после «Ок».
  proposeFree: (pings: boolean) => `Без таймера${pings ? ', загляну раз в полчаса' : ''}. Начинаем? Закончишь — /done.`,
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
  // Меняется текущий рабочий период: после перерыва начинается новый полный.
  askRunningDuration: 'Сколько должен длиться текущий рабочий период? Напиши, например: 25 минут.',
  badRunningDuration: 'Не понял длительность. Напиши, например: 25 минут или 1 час.',
  runningDurationTooShort: (elapsed: number) =>
    `В этом периоде уже прошло ${elapsed} ${plural(elapsed, 'минута', 'минуты', 'минут')}. Укажи длительность больше.`,
  runningWorkUpdated: (intent: string) => `Работу изменил на «${intent.replace(/\s+/g, ' ').trim().slice(0, 80)}». Таймер продолжается.`,
  runningTaskChoice: (title: string) => `«${title.replace(/\s+/g, ' ').trim().slice(0, 80)}» — это новая задача или выбрать существующую из списка?`,
  runningTaskNewButton: 'Новая задача',
  runningTaskExistingButton: 'Из списка',
  runningTaskChoiceCancelled: 'Хорошо, задачу не добавляю. Таймер продолжается.',
  runningTaskAdded: (title: string) => `Задачу «${title.replace(/\s+/g, ' ').trim().slice(0, 80)}» добавил к текущей сессии. Таймер продолжается.`,
  runningDurationUpdated: (minutes: number, end: string) =>
    `Длительность изменил: ${minutesText(minutes)}. Новое время окончания — ${end}.`,
  cancelled: 'Старт отменил. Новую задачу не сохранял.',
  alreadyRunning: (end: string | null) =>
    end ? `Сессия идёт до ${end}. Закончить раньше — /done, бросить — /stop.` : 'Сессия идёт. Закончить — /done, бросить — /stop.',
  sessionHelpContinue: 'Продолжаем. Вернись к текущему маленькому шагу.',
  sessionHelpAction: {
    continue: 'Продолжить',
    change_step: 'Изменить следующий шаг',
    finish: 'Завершить',
  },
  stopped: 'Остановил. Бывает — вернёмся, когда сможешь.',
  nothingRunning: 'Сейчас сессии нет. Напиши, с чего начнёшь.',
  breakStarted: (end: string) => `Рабочий период завершён. Отдыхай — напишу в ${end}.`,
  breakChoice: 'Ты на перерыве. Вернуться к прежней задаче или начать новую сессию?',
  breakOver: 'Перерыв закончился. Возвращаемся? «Вернуться к работе» — продолжим ту же сессию, «Начать новую сессию» — с чистого листа.',
  // Перерыв на часы — уже не перерыв: сессия закрывается, отработанное до
  // перерыва засчитывается.
  breakExpired: (minutes: number, counted: boolean) =>
    counted
      ? `Перерыв затянулся — закрыл сессию и засчитал ${minutesAcc(minutes)} работы до него. Вернёшься — нажми «Начать сессию».`
      : 'Перерыв затянулся — закрыл сессию. Вернёшься — нажми «Начать сессию».',
  breakResumed: (minutes: number | null, end: string | null) =>
    minutes === null
      ? 'Продолжаем. Начался новый свободный период работы.'
      : `Продолжаем. Новый период работы — ${minutes} минут${end ? `, до ${end}` : ''}.`,
  nothingToPause: 'Сессия ещё не идёт — ставить на паузу нечего.',
  nothingPaused: 'Сейчас нет сессии на перерыве.',
  restingIdle: 'Отдыхай. Как захочется продолжить — начни новую сессию.',

  // --- Пинг: шаблон, без модели.
  ping: 'На месте?',
  pingHere: 'Да, работаю',
  pingBack: 'Возвращаюсь к делу',
  pingAnsweredHere: 'Отлично, продолжаем.',
  pingAnsweredBack: 'Бывает. Я тут — продолжаем.',

  // --- Конец и отчёт. Исход троичный.
  sessionEnd: 'Время вышло: поработай ещё или пора отдыхать?',
  deadlineContinue: (end: string) => `Хорошо, ещё ${DEADLINE_EXTEND_MINUTES} минут — напишу в ${end}. Закончишь раньше — /done.`,
  deadlineBreakStarted: (minutes: number, end: string) => `Перерыв начался: ${minutes} минут. Напишу в ${end}.`,
  // Сессия закончилась без ответа: время засчитано, а не выброшено.
  autoFinished: (minutes: number, counted: boolean) =>
    counted
      ? `Сессия закончилась без ответа — засчитал ${minutesAcc(minutes)} работы. Если хочешь, пара слов — что вышло?`
      : 'Сессия закончилась без ответа. Вернёшься — напиши, с чего продолжишь.',
  deadlineContinueButton: 'Ещё поработаю',
  deadlineBreakButton: 'Пора отдыхать',
  sessionEndEarly: 'Как прошло?',
  outcome: { done: 'Готово', not_done: 'Пока не готово', other: 'Ушло в другое' } satisfies Record<Outcome, string>,
  askReport: 'Пара слов — что вышло? Можно пропустить.',
  stuck: (task: string) => `По «${task}» уже третья сессия без сдвига. Давай в следующий раз возьмём шаг поменьше — какой самый маленький кусок можно закончить?`,

  // --- Отдых: спрашиваем, а не назначаем.
  askRest: (rest: number, skipped = false) => `${skipped ? '' : 'Записал. '}Отдохнёшь ${rest} минут?`,
  restOk: (rest: number) => `Отдохну ${rest}`,
  restContinue: 'Уточнить следующий шаг',
  continuePrompt: (task: string, minutes: number | null) =>
    `Понял, хочешь продолжить «${task}» сейчас. Таймер ещё не запущен.${minutes === null ? '' : ` Можно сделать ещё ${minutes} минут.`}`,
  continueSame: (task: string, minutes: number | null) =>
    minutes === null ? `▶ Продолжить «${task}»` : `▶ Ещё ${minutes} мин — ${task}`,
  continueClarify: 'Уточнить следующий шаг',
  continueChange: 'Сменить задачу',
  collectingFeedback: (hasIntent: boolean) =>
    hasIntent
      ? 'Таймер ещё не запущен: я жду подтверждения длительности. Нажми «Ок» или измени её.'
      : 'Таймер ещё не запущен. Напиши, с чего начнёшь, или нажми «Начать сессию».',
  runningFeedback: 'Сессия уже идёт. Чтобы изменить работу, нажми «Изменить работу»; закончить — /done.',
  pausedFeedback: 'Сейчас перерыв. Выбери «Вернуться к работе» или «Начать новую сессию».',
  idleFeedback: 'Сессия сейчас не идёт. Нажми «Начать сессию» или напиши, с чего начнёшь.',
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
  // «Доброе утро» в 15:00 звучит странно: приветствие — по местному часу.
  meetingMorning: (hour: number) => `${hour < 12 ? 'Доброе утро!' : 'Привет!'} Пора работать.`,
  meetingPlain: 'Привет! С чего начнёшь?',
  morningNoTasks: (hour: number) =>
    `${hour < 12 ? 'Доброе утро!' : 'Привет!'} Пора работать. Можно начать без задачи или написать, что будешь делать.`,
  quickStart: '▶️ Просто начать',
  planDay: 'План на день',
  later: 'Позже',
  askNextMeeting: 'Когда встретимся в следующий раз?',
  tomorrowAt: (at: string) => `Завтра в ${at}`,
  dayOffButton: 'Завтра выходной',
  dayOffSet: (at: string) => `Завтра выходной — серия не прервётся. Напишу послезавтра в ${at}.`,
  dayOffTaken: 'На этой неделе выходной уже был — следующий можно взять с понедельника.',
  dayOffAlready: (at: string) => `Завтра и так выходной. Напишу послезавтра в ${at}.`,

  // --- Третий отказ подряд: спросить вслух.
  declineCheck: 'Третий раз откладываем. Хочешь паузу или не получается начать?',
  wantPause: 'Паузу до завтра',
  cantStart: 'Не получается начать',
  tinyStep: 'Давай с самого маленького: 10 минут, любое действие по задаче. С чего начнёшь?',
  pauseSet: (at: string, day: 'today' | 'tomorrow') => `Отдыхай. Напишу ${day === 'today' ? 'сегодня' : 'завтра'} в ${at}.`,

  // --- День.
  goalSet: (n: number) => `Цель на сегодня — ${n} ${plural(n, 'заход', 'захода', 'заходов')}. С чего начнёшь?`,
  askGoal: 'Сколько заходов сегодня?',
  goalLater: 'Хорошо, цель можно поставить позже — /goal.',
  timeAllocated: (minutes: number) => `Распределил ${minutesText(minutes)} между задачами.`,
  timeAllocationInvalid: 'Не смог надёжно распределить время: указанные минуты превышают фактическую работу. Сам отчёт сохранил без изменений.',
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
  summary: (s: DaySummary, day?: string) =>
    [
      s.sessions === 0
        ? s.inProgress
          ? `${s.inProgress === 'paused' ? 'Сессия на перерыве' : 'Сессия ещё идёт'} — итог посчитаю, когда закончишь.`
          : day ? `За ${day.split('-').reverse().join('.')} сессий не было — бывает.` : 'Сегодня сессий не было — бывает.'
        : `За ${day ? day.split('-').reverse().join('.') : 'сегодня'}: ${s.sessions} ${plural(s.sessions, 'сессия', 'сессии', 'сессий')}` +
          outcomesLine(s),
      s.totalMinutes !== undefined ? `Фактически в работе: ${s.totalMinutes} мин.${s.unassignedMinutes ? ` Без привязки к задаче: ${s.unassignedMinutes} мин.` : ''}` : null,
      s.sessions > 0 && s.inProgress ? (s.inProgress === 'paused' ? 'Ещё одна — на перерыве.' : 'Ещё одна идёт сейчас.') : null,
      s.target ? `Цель: ${s.counted} из ${s.target}.` : null,
      s.abandoned > 0 ? `Брошено: ${s.abandoned}.` : null,
      s.taskTimes.length
        ? [
            'По задачам:',
            ...s.taskTimes.map((task) => {
              const time = task.minutes === 0 ? 'меньше минуты' : minutesText(task.minutes)
              if (!task.completed) return `• ${task.title} — ${time}`
              return `• ${task.title} — ${task.minutes === 0 ? 'выполнено без таймера' : `выполнено, ${time}`}`
            }),
          ].join('\n')
        : null,
      `Серия: ${s.streak} ${plural(s.streak, 'день', 'дня', 'дней')}. Очки за ${day ? day.split('-').reverse().join('.') : 'сегодня'}: ${s.points}.`,
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
  suggestLongInline: 'Ты стабильно просишь продлить — похоже, тебе подходят длинные блоки. Учту это в следующем предложении.',
  suggestShortInline: 'Последние заходы давались тяжело — учту это и предложу следующий блок короче.',
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
    `${onboardingGuide}\n\nКоманды:\n` +
    '/focus — начать сессию\n/status — текущий режим, время и задача\n/tasks — мои задачи\n/done — закончить раньше\n/stop — бросить сессию\n' +
    '/today — на сегодня всё\n/goal — цель на день\n/dayoff — завтра выходной\n/settings — настройки\n' +
    '/profile — что я о тебе помню\n/guide — подробная инструкция\n/delete_me — удалить все данные',
  guide: `Подробная инструкция с примерами и картинками: ${GUIDE_URL}`,

  // Ошибка наружу — общая фраза; подробности только во внутреннем логе.
  error: 'Что-то пошло не так. Попробуй ещё раз чуть позже.',
  stale: 'Это уже неактуально.',
  tooFast: 'Слишком быстро — подожди минуту.',
  unsupported: 'Пока понимаю только текст и голосовые сообщения.',
} as const

export type DaySummary = {
  sessions: number
  totalMinutes?: number
  unassignedMinutes?: number
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
  taskTimes: { title: string; minutes: number; completed: boolean }[]
  // Сессия, которая идёт или стоит на перерыве в момент итога.
  inProgress: 'running' | 'paused' | null
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
