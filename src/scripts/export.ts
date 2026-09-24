// Выгрузка для организаторов конкурса — подтверждение метрик и антифрод
// (Положение, п. 5.2 и Прил. 2, п. 5.1: логи, источники трафика, обезличенные
// идентификаторы, даты и время событий, типы вызовов, результаты, коды ошибок).
//
//   npm run export -- --from 2026-11-03 --to 2026-11-30 --out ./export-2026-11
//
// Границы — московские сутки. Пишутся три CSV: events.csv, component_calls.csv,
// subjects.csv. Текста пользователей в журналах нет по построению (строгие схемы
// payload, в журнале вызовов — только машинные поля), поэтому выгрузка не
// требует отдельной чистки. Команда и тестовые аккаунты не вырезаются, а
// помечаются is_team: исключение видно и проверяемо.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { prisma } from '../lib/db.js'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

const day = /^\d{4}-\d{2}-\d{2}$/
const from = arg('from')
const to = arg('to')
const out = arg('out')
if (!from || !to || !out || !day.test(from) || !day.test(to)) {
  console.error('использование: export --from YYYY-MM-DD --to YYYY-MM-DD --out <папка>')
  process.exit(1)
}

function cell(v: unknown): string {
  if (v === null || v === undefined) return ''
  const s = v instanceof Date ? v.toISOString() : typeof v === 'object' ? JSON.stringify(v) : String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

function csv(rows: Record<string, unknown>[], columns: string[]): string {
  return [columns.join(','), ...rows.map((r) => columns.map((c) => cell(r[c])).join(','))].join('\n') + '\n'
}

async function main() {
  const events = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT e.subject_id, e.created_at, msk_day(e.created_at) AS day_msk, e.type, e.is_user_action,
           e.session_id, e.payload, (t.subject_id IS NOT NULL) AS is_team
    FROM events e LEFT JOIN team_subjects t ON t.subject_id = e.subject_id
    WHERE msk_day(e.created_at) BETWEEN ${from} AND ${to}
    ORDER BY e.id`
  const calls = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT c.subject_id, c.created_at, msk_day(c.created_at) AS day_msk, c.component, c.name, c.skill, c.model,
           c.status, c.error_code, c.latency_ms, c.input_tokens, c.output_tokens, c.session_id,
           (t.subject_id IS NOT NULL) AS is_team
    FROM component_calls c LEFT JOIN team_subjects t ON t.subject_id = c.subject_id
    WHERE msk_day(c.created_at) BETWEEN ${from} AND ${to}
    ORDER BY c.id`
  // Источник трафика — метка deep link из первого /start (bot_started.source).
  const subjects = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT DISTINCT ON (e.subject_id) e.subject_id, e.payload->>'source' AS source, e.created_at AS first_start,
           (t.subject_id IS NOT NULL) AS is_team
    FROM events e LEFT JOIN team_subjects t ON t.subject_id = e.subject_id
    WHERE e.type = 'bot_started'
    ORDER BY e.subject_id, e.id`

  mkdirSync(out!, { recursive: true })
  writeFileSync(
    join(out!, 'events.csv'),
    csv(events, ['subject_id', 'created_at', 'day_msk', 'type', 'is_user_action', 'session_id', 'payload', 'is_team']),
  )
  writeFileSync(
    join(out!, 'component_calls.csv'),
    csv(calls, ['subject_id', 'created_at', 'day_msk', 'component', 'name', 'skill', 'model', 'status', 'error_code', 'latency_ms', 'input_tokens', 'output_tokens', 'session_id', 'is_team']),
  )
  writeFileSync(join(out!, 'subjects.csv'), csv(subjects, ['subject_id', 'source', 'first_start', 'is_team']))
  console.log(`events: ${events.length}, component_calls: ${calls.length}, subjects: ${subjects.length} → ${out}`)
}

await main()
await prisma.$disconnect()
