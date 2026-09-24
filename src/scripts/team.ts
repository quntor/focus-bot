// Пометка аккаунтов команды и тестовых аккаунтов: их активность не входит в
// зачётные цифры (Положение, п. 5.1.3 — активность участников команды и
// связанных с ними лиц недобросовестна).
//
//   npm run team -- add --tg 123456789 --kind member   участник команды
//   npm run team -- add --tg 123456789 --kind test     тестовый аккаунт
//   npm run team -- remove --tg 123456789
//   npm run team -- list
//
// Telegram id нужен только для поиска: в таблицу попадает псевдоним subject_id,
// и исключение действует на весь журнал задним числом.
import { prisma } from '../lib/db.js'

const KINDS = ['member', 'test'] as const

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

function usage(): never {
  console.error('использование: team add --tg <telegram id> --kind member|test | team remove --tg <telegram id> | team list')
  process.exit(1)
}

async function subjectByTg(): Promise<string> {
  const raw = arg('tg')
  if (!raw || !/^\d{1,20}$/.test(raw)) usage()
  const user = await prisma.user.findUnique({ where: { tgId: BigInt(raw) }, select: { subjectId: true } })
  if (!user) {
    console.error('пользователь с таким Telegram id не найден: сначала /start в боте')
    process.exit(1)
  }
  return user.subjectId
}

async function main() {
  const command = process.argv[2]
  if (command === 'add') {
    const kind = arg('kind')
    if (!kind || !(KINDS as readonly string[]).includes(kind)) usage()
    const subjectId = await subjectByTg()
    await prisma.teamSubject.upsert({ where: { subjectId }, create: { subjectId, kind }, update: { kind } })
    console.log(`помечен как ${kind}`)
  } else if (command === 'remove') {
    const subjectId = await subjectByTg()
    const res = await prisma.teamSubject.deleteMany({ where: { subjectId } })
    console.log(res.count === 1 ? 'пометка снята' : 'пометки не было')
  } else if (command === 'list') {
    const rows = await prisma.teamSubject.findMany({ orderBy: { createdAt: 'asc' } })
    console.table(rows.map((r) => ({ subject_id: r.subjectId, kind: r.kind, since: r.createdAt.toISOString() })))
  } else {
    usage()
  }
}

await main()
await prisma.$disconnect()
