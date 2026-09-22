import { PrismaClient, type Prisma } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import { Pool } from 'pg'

const g = globalThis as unknown as { _prisma?: PrismaClient }

function client(): PrismaClient {
  if (!g._prisma) {
    const url = process.env.DATABASE_URL
    if (!url) throw new Error('DATABASE_URL не задан')
    g._prisma = new PrismaClient({ adapter: new PrismaPg(new Pool({ connectionString: url })) })
  }
  return g._prisma
}

// Ленивое подключение через прокси: модуль можно импортировать в тестах и
// скриптах, не поднимая пул соединений ради одной чистой функции рядом.
export const prisma = new Proxy({} as PrismaClient, {
  get(_target, prop: string | symbol) {
    return (client() as unknown as Record<string | symbol, unknown>)[prop]
  },
})

// Клиент или транзакция — всё, что пишет в базу, принимает одно из двух.
// Изменение состояния, начисление и событие идут одной транзакцией, поэтому
// функции не открывают свою, а работают в той, что им дали.
export type Db = Prisma.TransactionClient
