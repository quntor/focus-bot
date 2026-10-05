import { createHash } from 'node:crypto'
import type { z } from 'zod'
import { logEvent } from '../analytics/log.js'
import { PAYLOADS } from '../analytics/payloads.js'
import type { Keyboard } from '../tg/client.js'
import type { Ctx } from './context.js'

type Prompt = z.infer<typeof PAYLOADS.task_number_prompt>
const TTL = 6 * 60 * 60_000

async function fingerprint(ctx: Ctx, userId: string): Promise<string> {
  const [user, active] = await Promise.all([
    ctx.db.user.findUniqueOrThrow({ where: { id: userId }, select: { pendingInput: true } }),
    ctx.db.focusSession.findFirst({ where: { userId, state: { in: ['collecting_intent', 'running', 'paused'] } }, select: { id: true, state: true, taskId: true, plannedEndAt: true } }),
  ])
  return createHash('sha256').update(JSON.stringify({ pending: user.pendingInput, active })).digest('hex')
}

async function latest(ctx: Ctx, userId: string) {
  const user = await ctx.db.user.findUniqueOrThrow({ where: { id: userId }, select: { subjectId: true } })
  return ctx.db.event.findFirst({ where: { subjectId: user.subjectId, type: 'task_number_prompt' }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] })
}

// Store only IDs and numbered callbacks, never titles. No schema migration or
// replacement of pendingInput: a list can coexist with an unfinished report.
// Called only after a successful send; other replies retire the shown list.
export async function rememberTaskNumberPrompt(ctx: Ctx, userId: string, text: string, keyboard?: Keyboard): Promise<void> {
  const buttons = keyboard?.flat().filter((b) => b.data.startsWith('task:') && !b.data.endsWith(':restore')) ?? []
  // Notices may contain a separate numbered capture summary before the actual
  // active list. The displayed callback rows belong to the final list only.
  const lines = [...text.matchAll(/^(\d+)\. (.+)$/gm)].slice(-buttons.length)
  const numbers = lines.map((m) => Number(m[1]))
  const matches = buttons.map((b) => /^task:([0-9a-f-]{36}):(start|view\d+)$/.exec(b.data))
  // A breakdown also has numbered steps, but its one "start first" callback
  // is not a numbered task picker. Require each row's displayed task label.
  const labelsMatch = lines.length === buttons.length && lines.every((line, i) => {
    const title = line[2]!.replace(/\s+/g, ' ').trim()
    const label = buttons[i]!.text
    return title === label || label.endsWith('…') && title.startsWith(label.slice(0, -1))
  })
  const valid = buttons.length > 0 && numbers.length === buttons.length && matches.every(Boolean) && labelsMatch
  let prompt: Prompt
  if (valid) {
    prompt = { fingerprint: await fingerprint(ctx, userId), choices: matches.map((m, i) => ({
      number: numbers[i]!, task_id: m![1]!, mode: m![2] === 'start' ? 'start' : 'actions',
      page: Math.floor((numbers[i]! - 1) / 6),
    })) }
  } else {
    const prior = await latest(ctx, userId)
    if (!prior || !PAYLOADS.task_number_prompt.parse(prior.payload).choices.length) return
    prompt = { fingerprint: null, choices: [] }
  }
  await logEvent(ctx.db, userId, 'task_number_prompt', prompt, { at: ctx.now() })
}

export async function taskNumberPrompt(ctx: Ctx, userId: string): Promise<Prompt | null> {
  const event = await latest(ctx, userId)
  if (!event || ctx.now().getTime() - event.createdAt.getTime() > TTL) return null
  const prompt = PAYLOADS.task_number_prompt.parse(event.payload)
  if (!prompt.choices.length || prompt.fingerprint !== await fingerprint(ctx, userId)) return null
  return prompt
}
