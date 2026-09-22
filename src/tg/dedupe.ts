import type { PrismaClient } from '@prisma/client'

// Захват update_id до обработки. Возвращает false, если апдейт уже видели.
//
// Захватываем именно до, а не после: если обработка упадёт на середине, апдейт
// потеряется, но не выполнится дважды. Для бота, который начисляет очки и пишет
// людям, лишний дубль хуже потерянного касания — человек просто повторит.
export async function claimUpdate(db: Pick<PrismaClient, '$executeRaw'>, updateId: number): Promise<boolean> {
  const inserted = await db.$executeRaw`
    INSERT INTO processed_updates (update_id) VALUES (${BigInt(updateId)})
    ON CONFLICT (update_id) DO NOTHING`
  return inserted === 1
}
