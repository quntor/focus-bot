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

// «14:30», «9.05», «21 40» → часы и минуты.
export function parseClock(text: string): { h: number; m: number } | null {
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
    const naive = Date.UTC(parts[0]!, parts[1]! - 1, parts[2]!, clock.h, clock.m)
    const candidate = new Date(naive - offsetMinutes(timezone, new Date(naive)) * 60_000)
    if (candidate.getTime() > after.getTime()) return candidate
  }
  return new Date(after.getTime() + 86_400_000)
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
