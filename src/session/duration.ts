// Длительность внутри намерения. Бот о длительности не спрашивает: назвал человек
// время сам — оно принимается, не назвал — бот предлагает число, человек двигает.
//
// Разбор детерминированный и идёт до модели: «за час» не должно зависеть от
// того, доступна ли она сейчас.

// Названное человеком время принимается почти как есть: «сяду на три часа» —
// значит три часа. Границы только от явной ошибки ввода.
export const USER_MIN = 5
export const USER_MAX = 240
// Предложение бота — стартовое число, в узких рамках.
export const PROPOSE_MIN = 15
export const PROPOSE_MAX = 90
export const PROPOSE_DEFAULT = 40
export const STEP = 10

const WORD_NUMBERS: Record<string, number> = {
  один: 1, одну: 1, два: 2, две: 2, три: 3, четыре: 4, пять: 5, шесть: 6,
  десять: 10, пятнадцать: 15, двадцать: 20, тридцать: 30, сорок: 40, пятьдесят: 50,
}

const NUM = String.raw`(\d+(?:[.,]\d+)?|${Object.keys(WORD_NUMBERS).join('|')})`
// «часам», «часах» и т. п. не матчатся: «к трём часам» — это срок, а не длительность.
const HOURS = String.raw`(?:час(?:а|ов)?|ч)(?![а-яё])`
const MINUTES = String.raw`(?:мин(?:ут[аы]?|уток|утку)?|м)(?![а-яё])`

function toNumber(raw: string): number {
  const word = WORD_NUMBERS[raw.toLowerCase()]
  return word ?? Number(raw.replace(',', '.'))
}

const clampUser = (n: number) => Math.min(USER_MAX, Math.max(USER_MIN, Math.round(n)))

// Возвращает названные минуты или null, если время не названо.
export function parseNamedMinutes(text: string): number | null {
  const t = text.toLowerCase().replace(/ё/g, 'е')

  if (/полтора\s+час/.test(t)) return 90
  if (/(?<![а-я])полчаса(?![а-я])/.test(t)) return 30

  const hm = new RegExp(`${NUM}\\s*${HOURS}\\s*${NUM}\\s*${MINUTES}`, 'u').exec(t)
  if (hm) return clampUser(toNumber(hm[1]!) * 60 + toNumber(hm[2]!))

  const h = new RegExp(`${NUM}\\s*${HOURS}`, 'u').exec(t)
  if (h) return clampUser(toNumber(h[1]!) * 60)

  const m = new RegExp(`${NUM}\\s*${MINUTES}`, 'u').exec(t) ?? new RegExp(`${MINUTES}\\s*${NUM}(?![\\d:])`, 'u').exec(t)
  if (m) return clampUser(toNumber(m[1]!))

  // «за час», «на час», «час поработаю» — без числа.
  if (/(?<![а-я])час(?![а-я])/.test(t)) return 60
  return null
}

export type PastSession = {
  state: string
  plannedMinutes: number | null
  counted: boolean
  minutesAdjusted: string | null
  restChoice: string | null
}

const round5 = (n: number) => Math.round(n / 5) * 5
const clampPropose = (n: number) => Math.min(PROPOSE_MAX, Math.max(PROPOSE_MIN, round5(n)))

// Предложение длины по истории, новые сессии первыми. Код, а не модель: число
// должно быть объяснимо правилом.
// - нет истории — 40;
// - основа — медиана длины последних засчитанных;
// - две последние брошены или человек двигал вниз — короче на шаг;
// - три последние досидел и просил ещё (двигал вверх или сразу продолжал) —
//   длиннее на шаг.
export function proposeMinutes(history: PastSession[]): number {
  const counted = history.filter((s) => s.counted && s.plannedMinutes).slice(0, 5)
  const lengths = counted.map((s) => s.plannedMinutes!).sort((a, b) => a - b)
  const base = lengths.length ? lengths[Math.floor((lengths.length - 1) / 2)]! : PROPOSE_DEFAULT

  const lastTwo = history.slice(0, 2)
  if (lastTwo.length === 2 && lastTwo.every((s) => s.state === 'abandoned' || s.minutesAdjusted === 'down')) {
    return clampPropose(base - STEP)
  }
  const lastThree = history.slice(0, 3)
  if (
    lastThree.length === 3 &&
    lastThree.every((s) => s.counted && (s.minutesAdjusted === 'up' || s.restChoice === 'continue'))
  ) {
    return clampPropose(base + STEP)
  }
  return clampPropose(base)
}

// Кнопки «короче/длиннее» — шаг 10, в границах названного человеком времени.
export function adjust(minutes: number, direction: 'up' | 'down'): number {
  return Math.min(USER_MAX, Math.max(USER_MIN, minutes + (direction === 'up' ? STEP : -STEP)))
}

// Отдых считает код по длине сессии. Отдельного вопроса про отдых нет.
export function restFor(minutes: number | null): number {
  if (minutes === null) return 10
  if (minutes <= 30) return 5
  if (minutes <= 60) return 10
  if (minutes <= 90) return 15
  return 20
}
