// Часы и пояса без внешних библиотек: Intl в Node знает базу поясов, а лишняя
// зависимость ради двух функций — лишняя поверхность.

// Смещение пояса относительно UTC в минутах в данный момент.
export function offsetMinutes(timezone: string, at: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(at)
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value)
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'))
  return Math.round((asUtc - Math.floor(at.getTime() / 60_000) * 60_000) / 60_000)
}

// Числа словами — цифрами: распознавание голоса пишет «четырнадцать тридцать»,
// «к девяти», «девять ноль пять». Только то, что бывает во времени суток.
const UNITS: Record<string, number> = { один: 1, одна: 1, одну: 1, два: 2, две: 2, три: 3, четыре: 4, пять: 5, шесть: 6, семь: 7, восемь: 8, девять: 9 }
const TENS: Record<string, number> = { двадцать: 20, тридцать: 30, сорок: 40, пятьдесят: 50 }
const OTHER: Record<string, number> = {
  ноль: 0, десять: 10, одиннадцать: 11, двенадцать: 12, тринадцать: 13, четырнадцать: 14, пятнадцать: 15,
  шестнадцать: 16, семнадцать: 17, восемнадцать: 18, девятнадцать: 19,
  двух: 2, трех: 3, четырех: 4, пяти: 5, шести: 6, семи: 7, восьми: 8, девяти: 9, десяти: 10, одиннадцати: 11, двенадцати: 12,
}
const word = (words: Record<string, number>) => Object.keys(words).join('|')
const TENS_UNITS = new RegExp(String.raw`(?<!\p{L})(${word(TENS)})\s+(${word(UNITS)})(?!\p{L})`, 'gu')
const ZERO_UNIT = new RegExp(String.raw`(?<!\p{L})ноль\s+(${word(UNITS)})(?!\p{L})`, 'gu')
const SINGLE = new RegExp(String.raw`(?<!\p{L})(${word(UNITS)}|${word(TENS)}|${word(OTHER)})(?!\p{L})`, 'gu')

export function spelledTime(text: string): string {
  return text
    .toLocaleLowerCase('ru')
    .replace(/ё/g, 'е')
    .replace(TENS_UNITS, (_, tens: string, unit: string) => String(TENS[tens]! + UNITS[unit]!))
    .replace(ZERO_UNIT, (_, unit: string) => `0${UNITS[unit]!}`)
    .replace(SINGLE, (value: string) => String(UNITS[value] ?? TENS[value] ?? OTHER[value]))
}

// «14:30», «9.05», «21 40», «девять тридцать» → часы и минуты.
export function parseClock(raw: string): { h: number; m: number } | null {
  const text = spelledTime(raw)
  const match = /^\s*(\d{1,2})\s*[:.\s]\s*(\d{2})\s*$/.exec(text) ?? /^\s*(\d{1,2})\s*$/.exec(text)
  if (!match) return null
  const h = Number(match[1])
  const m = match[2] === undefined ? 0 : Number(match[2])
  if (h > 23 || m > 59) return null
  return { h, m }
}

// Ближайший момент после `after`, когда в поясе пользователя будет HH:MM.
export function nextLocalTime(timezone: string, clock: { h: number; m: number }, after: Date): Date {
  for (let dayShift = 0; dayShift <= 2; dayShift++) {
    const base = new Date(after.getTime() + dayShift * 86_400_000)
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' })
      .format(base)
      .split('-')
      .map(Number)
    const candidate = atLocal(timezone, parts[0]!, parts[1]!, parts[2]!, clock)
    if (candidate.getTime() > after.getTime()) return candidate
  }
  return new Date(after.getTime() + 86_400_000)
}

function atLocal(timezone: string, year: number, month: number, day: number, clock: { h: number; m: number }): Date {
  const naive = Date.UTC(year, month - 1, day, clock.h, clock.m)
  return new Date(naive - offsetMinutes(timezone, new Date(naive)) * 60_000)
}

// Момент HH:MM календарной даты YYYY-MM-DD в поясе пользователя.
export function localDateTime(timezone: string, day: string, clock: { h: number; m: number }): Date {
  const [year, month, date] = day.split('-').map(Number)
  return atLocal(timezone, year!, month!, date!, clock)
}

// Российские пояса — по именам, чтобы в настройках стояло понятное название.
const RU_ZONES: Record<number, string> = {
  120: 'Europe/Kaliningrad',
  180: 'Europe/Moscow',
  240: 'Europe/Samara',
  300: 'Asia/Yekaterinburg',
  360: 'Asia/Omsk',
  420: 'Asia/Krasnoyarsk',
  480: 'Asia/Irkutsk',
  540: 'Asia/Yakutsk',
  600: 'Asia/Vladivostok',
  660: 'Asia/Magadan',
  720: 'Asia/Kamchatka',
}
const HALF_ZONES: Record<number, string> = {
  210: 'Asia/Tehran',
  270: 'Asia/Kabul',
  330: 'Asia/Kolkata',
  345: 'Asia/Kathmandu',
  390: 'Asia/Yangon',
  570: 'Australia/Darwin',
}

// Пояс по тому, сколько сейчас времени у человека. Telegram пояс не присылает,
// поэтому спрашиваем время и выводим смещение. Точность — до 15 минут: человек
// называет время с округлением, и минуты в пути сообщения тоже есть.
export function zoneFromLocalClock(clock: { h: number; m: number }, now: Date): { timezone: string; offset: number } {
  const local = clock.h * 60 + clock.m
  const utc = now.getUTCHours() * 60 + now.getUTCMinutes()
  let diff = local - utc
  if (diff > 14 * 60) diff -= 1440
  if (diff < -12 * 60) diff += 1440
  const offset = Math.round(diff / 15) * 15
  const named = RU_ZONES[offset] ?? HALF_ZONES[offset]
  if (named) return { timezone: named, offset }
  const hours = Math.round(offset / 60)
  // Etc/GMT-3 — это UTC+3: знак в этих именах обратный.
  const timezone = hours === 0 ? 'UTC' : `Etc/GMT${hours > 0 ? '-' : '+'}${Math.abs(hours)}`
  return { timezone, offset: hours * 60 }
}

// Час в поясе пользователя, 0–23.
export function localHour(timezone: string, at: Date): number {
  return Number(new Intl.DateTimeFormat('en-US', { timeZone: timezone, hourCycle: 'h23', hour: '2-digit' }).format(at))
}
