import { z } from 'zod'

// callback_data: «действие:id:аргумент», не длиннее 64 байт (Bot API).
//
// id в callback_data — только указатель на сущность, а не доказательство прав.
// Пользователь может прислать любой callback_data, в том числе с чужим id:
// каждый обработчик достаёт сущность запросом с фильтром по владельцу, которого
// определяет from.id проверенного апдейта, и ничем другим.
export const ACTIONS = [
  'consent',
  'len', // предложение длины: ok | up | down | cancel
  'ping', // here | back
  'out', // исход: done | not_done | other
  'skiprep', // пропустить отчёт
  'rest', // rest | continue | later | day_end
  'meet', // h1 | h2 | evening | custom | morning
  'mtg', // ответ на напоминание: postpone | day_end
  'dec', // pause | stuck
  'goal', // 1..5 | later
  'sum', // закрыть день по сводке
  'set', // technique | pings | proactive | morning | timezone
  'tech', // auto | pomodoro | medium | long | free
  'prof', // edit | clear | ritual
  'del', // confirm
  'skip', // пропустить вопрос онбординга: ritual
] as const
export type Action = (typeof ACTIONS)[number]

const schema = z.object({
  action: z.enum(ACTIONS),
  id: z.uuid().nullable(),
  arg: z.string().regex(/^[a-z0-9_]{1,16}$/).nullable(),
})

export type Callback = z.infer<typeof schema>

export function cb(action: Action, id?: string | null, arg?: string | null): string {
  const data = `${action}:${id ?? ''}:${arg ?? ''}`
  if (Buffer.byteLength(data) > 64) throw new Error('callback_data длиннее 64 байт')
  return data
}

export function parseCallback(data: string | undefined): Callback | null {
  if (!data || Buffer.byteLength(data) > 64) return null
  const [action, id, arg, ...rest] = data.split(':')
  if (rest.length > 0) return null
  const parsed = schema.safeParse({ action, id: id || null, arg: arg || null })
  return parsed.success ? parsed.data : null
}
