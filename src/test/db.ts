// Подключение тестов к базе. Боевой DATABASE_URL здесь не используется никогда:
// тесты стирают таблицы, и перепутанная переменная стоила бы данных.
const url = process.env.TEST_DATABASE_URL
if (url) process.env.DATABASE_URL = url

export const hasDb = Boolean(url)

const { prisma } = await import('../lib/db.js')
export { prisma }

// Порядок не важен: TRUNCATE ... CASCADE снимает зависимости сам.
export async function resetDb(): Promise<void> {
  const rows = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`
  if (rows.length === 0) return
  const list = rows.map((r) => `"${r.tablename}"`).join(', ')
  await prisma.$executeRawUnsafe(`TRUNCATE ${list} RESTART IDENTITY CASCADE`)
}
