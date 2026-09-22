// Внутренний лог. Текст пользователя сюда не попадает ни на каком уровне, и это
// обеспечивается типами и фильтром, а не дисциплиной вызывающего кода: одна
// забытая интерполяция — и формулировка «написать Кате про увольнение» лежит в
// логах хостинга, откуда её уже не вычистить.
//
// Поэтому:
// - значения полей — только числа, булевы и короткие машинные строки
//   (идентификаторы, коды, enum). Всё, что похоже на человеческий текст, заменяется;
// - у ошибок берём имя класса и код, но никогда message: сообщения чужих
//   библиотек цитируют вход (JSON.parse — кусок тела, Prisma — аргументы запроса).

type Field = string | number | boolean | bigint | null | undefined
export type LogFields = Record<string, Field>

// Машинная строка: латиница, цифры и немного пунктуации, без пробелов. Русский
// текст, фраза с пробелами или что-то длинное сюда не пролезет.
const MACHINE = /^[A-Za-z0-9_.:\-/]{0,80}$/

function clean(fields: LogFields | undefined): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {}
  if (!fields) return out
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue
    if (typeof value === 'bigint') out[key] = value.toString()
    else if (typeof value === 'string') out[key] = MACHINE.test(value) ? value : '[redacted]'
    else out[key] = value
  }
  return out
}

// Код ошибки без текста: у Prisma это P2002 и т. п., у Telegram — HTTP-код,
// у сетевых ошибок Node — ECONNRESET и т. п. Больше ничего не берём.
export function errorCode(error: unknown): string | number | null {
  if (typeof error !== 'object' || error === null) return null
  const e = error as { code?: unknown; cause?: { code?: unknown } }
  if (typeof e.code === 'string' || typeof e.code === 'number') return e.code
  if (e.cause && (typeof e.cause.code === 'string' || typeof e.cause.code === 'number')) return e.cause.code
  return null
}

function errorName(error: unknown): string {
  if (error instanceof Error) return error.name
  return typeof error
}

type Sink = (line: string) => void
let sink: Sink = (line) => process.stdout.write(`${line}\n`)

// Для тестов: проверяем, что в вывод не утекает текст.
export function setLogSink(next: Sink): void {
  sink = next
}

function write(level: 'info' | 'warn' | 'error', event: string, fields?: LogFields): void {
  const name = MACHINE.test(event) ? event : '[redacted]'
  sink(JSON.stringify({ t: new Date().toISOString(), level, event: name, ...clean(fields) }))
}

export const log = {
  info: (event: string, fields?: LogFields) => write('info', event, fields),
  warn: (event: string, fields?: LogFields) => write('warn', event, fields),
  error: (event: string, error: unknown, fields?: LogFields) =>
    write('error', event, { ...fields, error: errorName(error), code: errorCode(error) }),
}
