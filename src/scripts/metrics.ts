// Внутренний дашборд в терминале: npm run metrics -- --from 2026-10-01 --to 2026-10-15 --segment active
//
// Сегменты: all (вся база), active | new | observer | dormant (по роли на момент
// события), roles (все роли рядом), sessions, minutes-source, technique, outbox.
// Любой разрез считается по требованию из журнала, без предположений о методике.
import { prisma } from '../lib/db.js'

const SEGMENTS = ['all', 'active', 'new', 'observer', 'dormant', 'roles', 'sessions', 'minutes-source', 'technique', 'outbox'] as const
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
