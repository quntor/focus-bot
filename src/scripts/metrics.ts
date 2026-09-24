// Внутренний дашборд в терминале: npm run metrics -- --from 2026-10-01 --to 2026-10-15 --segment active
//
// Сегменты: all (вся база), active | new | observer | dormant (по роли на момент
// события), roles (все роли рядом), sessions, minutes-source, technique, outbox.
// Здесь «действия» — нажатия и сообщения человека: внутренняя метрика
// вовлечённости, к зачёту конкурса она не относится.
//
// Зачёт по Положению: zachet — DAU по московским суткам без команды, обращения
// (вызовы компонентов) и сводка за период с порогами; call-errors — отказы
// вызовов по кодам. Для зачётного периода: --from 2026-11-03 --to 2026-11-30.
import { prisma } from '../lib/db.js'
import { daysBetween } from '../lib/day.js'
import { summarize, ZACHET, type ZachetDay } from '../analytics/zachet.js'

const SEGMENTS = ['all', 'active', 'new', 'observer', 'dormant', 'roles', 'sessions', 'minutes-source', 'technique', 'outbox', 'zachet', 'call-errors'] as const
type Segment = (typeof SEGMENTS)[number]

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback
}

const day = /^\d{4}-\d{2}-\d{2}$/
const from = arg('from', '2000-01-01')
const to = arg('to', '2999-12-31')
const segment = arg('segment', 'all') as Segment
if (!day.test(from) || !day.test(to) || !SEGMENTS.includes(segment)) {
  console.error(`использование: --from YYYY-MM-DD --to YYYY-MM-DD --segment ${SEGMENTS.join('|')}`)
  process.exit(1)
}

const plain = (rows: Record<string, unknown>[]) =>
  rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === 'bigint' ? Number(v) : v])))

async function main() {
  let rows: Record<string, unknown>[]
  switch (segment) {
    case 'all':
      rows = await prisma.$queryRaw`SELECT * FROM metrics_daily_all WHERE day_key BETWEEN ${from} AND ${to} ORDER BY day_key`
      break
    case 'roles':
      rows = await prisma.$queryRaw`SELECT * FROM metrics_daily_by_role WHERE day_key BETWEEN ${from} AND ${to} ORDER BY day_key, user_role`
      break
    case 'sessions':
      rows = await prisma.$queryRaw`SELECT * FROM metrics_sessions_daily WHERE day_key BETWEEN ${from} AND ${to} ORDER BY day_key`
      break
    case 'minutes-source':
      rows = await prisma.$queryRaw`SELECT * FROM metrics_by_minutes_source`
      break
    case 'technique':
      rows = await prisma.$queryRaw`SELECT * FROM metrics_by_technique`
      break
    case 'zachet': {
      rows = await prisma.$queryRaw`SELECT * FROM zachet_daily WHERE day_msk BETWEEN ${from} AND ${to} ORDER BY day_msk`
      console.table(plain(rows))
      // Длина периода — по границам, если обе заданы: пустые дни тоже дни.
      const bounded = process.argv.includes('--from') && process.argv.includes('--to')
      const days = plain(rows) as unknown as ZachetDay[]
      const summary = summarize(days, bounded ? daysBetween(from, to) + 1 : days.length)
      console.log(`пороги: DAU ≥ ${ZACHET.minDau} не менее ${ZACHET.steadyDays} дней и в среднем; обращений на DAU ≥ ${ZACHET.minCallsPerDau} (Н1: ≥ ${ZACHET.highFrequencyCallsPerDau})`)
      console.table([summary])
      return
    }
    case 'call-errors':
      rows = await prisma.$queryRaw`SELECT * FROM component_call_errors WHERE day_msk BETWEEN ${from} AND ${to} ORDER BY day_msk, calls DESC`
      break
    case 'outbox':
      rows = await prisma.$queryRaw`SELECT * FROM metrics_outbox_uncertain WHERE day_key BETWEEN ${from} AND ${to} ORDER BY day_key`
      break
    default:
      rows = await prisma.$queryRaw`SELECT * FROM metrics_daily_by_role WHERE user_role = ${segment} AND day_key BETWEEN ${from} AND ${to} ORDER BY day_key`
  }
  console.table(plain(rows))
}

await main()
await prisma.$disconnect()
