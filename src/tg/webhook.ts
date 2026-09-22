import { z } from 'zod'
import { prisma } from '../lib/db.js'
import { logEvent } from '../analytics/log.js'
import { parseCommand, parseSource } from './commands.js'
import { sendMessage } from './client.js'
import { claimUpdate } from './dedupe.js'

// Разбираем только то, что читаем. Остальные поля апдейта Telegram меняет чаще,
// чем выходят его же релизы, и строгая схема на всё сообщение ломала бы бота
// на ровном месте.
const updateSchema = z.object({
  update_id: z.number(),
  message: z
    .object({
      text: z.string().optional(),
      from: z.object({ id: z.number(), is_bot: z.boolean().optional() }).optional(),
      chat: z.object({ id: z.number() }),
    })
    .optional(),
})

export type Update = z.infer<typeof updateSchema>

const GREETING = [
  'Я напарник по рабочим сессиям.',
  '',
  'Скажешь, над чем работаешь, — засеку время, проверюсь в середине и спрошу в конце, что вышло.',
  'Пока я умею только знакомиться: сессии включатся на этой неделе.',
].join('\n')

export async function handleUpdate(raw: unknown): Promise<void> {
  const parsed = updateSchema.safeParse(raw)
  if (!parsed.success) return
  if (!(await claimUpdate(prisma, parsed.data.update_id))) return

  const message = parsed.data.message
  if (!message?.from || message.from.is_bot) return

  const command = parseCommand(message.text)
  if (command?.command !== 'start') return

  const tgId = BigInt(message.from.id)
  const existing = await prisma.user.findUnique({ where: { tgId } })
  // Метка источника ставится один раз. Повторный /start по чужой ссылке не
  // должен переписывать когорту, иначе замер каналов покажет не то, что было.
  const user =
    existing ??
    (await prisma.user.create({
      data: { tgId, source: parseSource(command.args) },
    }))

  await logEvent(prisma, user.id, 'bot_started', { source: user.source, returning: existing !== null })

  await sendMessage(message.chat.id, GREETING)
}
