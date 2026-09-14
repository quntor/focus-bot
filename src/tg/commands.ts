export type ParsedCommand = { command: string; args: string }

// Telegram присылает команду как обычный текст. В группах и по ссылке-приглашению
// к ней добавляется имя бота (/focus@focus_bot), а deep link кладёт параметр в
// аргумент (/start nn_chat) — разбираем всё это в одном месте, чтобы обработчики
// сравнивали команду со строкой, а не с регулярным выражением.
export function parseCommand(text: string | undefined): ParsedCommand | null {
  if (!text) return null
  const trimmed = text.trim()
  if (!trimmed.startsWith('/')) return null

  const space = trimmed.search(/\s/)
  const head = space === -1 ? trimmed : trimmed.slice(0, space)
  const args = space === -1 ? '' : trimmed.slice(space + 1).trim()

  const at = head.indexOf('@')
  const command = (at === -1 ? head : head.slice(0, at)).slice(1).toLowerCase()
  if (!command) return null

  return { command, args }
}

// Метка источника из deep link: t.me/bot?start=nn_chat. Всё, что длиннее и
// разнообразнее допустимого, отбрасываем — метка попадает в когорты и в базу,
// и мусор оттуда потом не вычистить.
export function parseSource(args: string): string | null {
  const candidate = args.split(/\s+/)[0] ?? ''
  return /^[a-z0-9_-]{1,32}$/i.test(candidate) ? candidate.toLowerCase() : null
}
