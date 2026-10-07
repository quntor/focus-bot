import { beforeEach, describe, expect, it } from 'vitest'
import { hasDb, prisma, resetDb } from '../test/db.js'
import { makeBot } from '../test/bot.js'
import { LlmCallError, type LlmProvider, type LlmReply, type LlmRequest } from '../llm/provider.js'
import { logEvent } from './log.js'
import { LLM_CALLS_PER_DAY } from './calls.js'

const A = 7001

function provider(reply: (req: LlmRequest) => Promise<LlmReply>): LlmProvider {
  return { enabled: true, model: 'test-model', complete: reply }
}

const okReply = (text: string): LlmReply => ({ text, usage: { inputTokens: 120, outputTokens: 30 } })
const happyReply = async (req: LlmRequest): Promise<LlmReply> => {
  const { text } = JSON.parse(req.input)
  const replies: Record<string, object> = {
    'набросать план главы, 30 минут': { route: 'new_task', text, intent: { task: null, title: 'план главы', scope: 'step' }, minutes: 30, durationSource: '30 минут', followUp: null },
    'план главы, 30 минут': { route: 'new_task', text, intent: { task: null, title: 'план главы', scope: 'step' }, minutes: 30, durationSource: '30 минут', followUp: null },
    'секретный проект Альфа, 30 минут': { route: 'new_task', text, intent: { task: null, title: 'секретный проект Альфа', scope: 'step' }, minutes: 30, durationSource: '30 минут', followUp: null },
    'план готов, осталось введение': { route: 'report', text, report: { route: 'report', progress: 'moved', next_step: 'введение', continue_now: false, continue_minutes: null, allocations: [] }, followUp: null },
    'застрял': { route: 'clarify', text, question: 'С чем нужна помощь?', followUp: null },
  }
  if (!replies[text]) throw new Error('unexpected model input')
  return okReply(JSON.stringify(replies[text]))
}

describe.skipIf(!hasDb)('журнал вызовов компонентов', () => {
  beforeEach(resetDb)

  it('каждый реальный вызов модели — строка с касанием, skill, статусом и токенами', async () => {
    const bot = makeBot({ llm: provider(happyReply) })
    await bot.setupOnboarded(A)
    await bot.text(A, 'набросать план главы, 30 минут')
    const s = await prisma.focusSession.findFirstOrThrow()
    bot.advance(30)
    await bot.press(A, `out:${s.id}:done`)
    await bot.text(A, 'план готов, осталось введение')

    const user = await prisma.user.findUniqueOrThrow({ where: { tgId: BigInt(A) } })
    const calls = await prisma.componentCall.findMany({ orderBy: { id: 'asc' } })
    expect(calls.map((c) => [c.component, c.name, c.skill, c.status, c.errorCode, c.inputTokens, c.outputTokens])).toEqual([
      ['llm', 'semantic_router', 'semantic_router', 'ok', null, 120, 30],
      ['llm', 'semantic_router', 'semantic_router', 'ok', null, 120, 30],
    ])
    expect(calls.every((c) => c.subjectId === user.subjectId && (c.sessionId === null || c.sessionId === s.id) && c.model === 'test-model')).toBe(true)
  })

  it('текст пользователя в журнал вызовов не попадает', async () => {
    const bot = makeBot({ llm: provider(happyReply) })
    await bot.setupOnboarded(A)
    await bot.text(A, 'секретный проект Альфа, 30 минут')
    const rows = await prisma.$queryRaw<Record<string, unknown>[]>`SELECT * FROM component_calls`
    expect(rows).toHaveLength(1)
    expect(JSON.stringify(rows, (_k, v) => (typeof v === 'bigint' ? Number(v) : v))).not.toContain('Альфа')
  })

  it('отказы пишутся со статусом и машинным кодом, состояние не изменяется', async () => {
    const cases: [() => Promise<LlmReply>, string, string][] = [
      [async () => ({ text: 'не JSON', usage: null }), 'invalid', 'not_json'],
      [async () => ({ text: JSON.stringify({ task: null, title: 'x', scope: 'step', points: 1000 }), usage: null }), 'invalid', 'schema'],
      [async () => { throw new LlmCallError('LLM request failed (HTTP 402)', 'http_402') }, 'error', 'http_402'],
      [async () => { throw new Error('что-то своё') }, 'error', 'error'],
    ]
    let tg = A
    for (const [failure, status, code] of cases) {
      await resetDb()
      const bot = makeBot({
        llm: provider(failure),
      })
      await bot.setupOnboarded(++tg)
      await bot.text(tg, 'план главы, 30 минут')
      const call = await prisma.componentCall.findFirstOrThrow({ where: { name: 'semantic_router' } })
      expect([call.status, call.errorCode]).toEqual([status, code])
      expect(await prisma.focusSession.count({ where: { state: { in: ['running','paused','finished'] } } })).toBe(0)
      expect(await prisma.pointsEntry.count()).toBe(0)
    }
  })

  it('выключенная модель вызова не делает — и строки нет', async () => {
    const bot = makeBot()
    await bot.setupOnboarded(A)
    await bot.text(A, 'план главы, 30 минут')
    expect(await prisma.componentCall.count()).toBe(0)
  })

  it('журнал вызовов только на дозапись', async () => {
    const bot = makeBot({ llm: provider(happyReply) })
    await bot.setupOnboarded(A)
    await bot.text(A, 'план главы, 30 минут')
    await expect(prisma.componentCall.updateMany({ data: { status: 'ok' } })).rejects.toThrow()
    await expect(prisma.componentCall.deleteMany()).rejects.toThrow()
  })
})

describe.skipIf(!hasDb)('зачётное представление', () => {
  beforeEach(resetDb)

  async function userWith(tgId: number) {
    return prisma.user.create({ data: { tgId: BigInt(tgId), createdAt: new Date('2026-08-01T00:00:00Z') } })
  }
  async function call(subjectId: string, at: Date, component = 'llm', status = 'ok') {
    await prisma.componentCall.create({
      data: { subjectId, component, name: 'intent', skill: component === 'llm' ? 'intent' : null, status, latencyMs: 100, createdAt: at },
    })
  }

  it('сутки московские, команда исключена, вызовы молчащих не делятся на DAU', async () => {
    // 21:30 UTC 1 ноября — это уже 00:30 2 ноября по Москве.
    const lateUtc = new Date('2026-11-01T21:30:00Z')
    const day = new Date('2026-11-02T09:00:00Z')

    const a = await userWith(1)
    await logEvent(prisma, a.id, 'intent_submitted', { length_chars: 5, named_minutes: false }, { at: lateUtc })
    await call(a.subjectId, lateUtc)
    await call(a.subjectId, day)
    await call(a.subjectId, day, 'llm', 'timeout') // отказ — не обращение
    await call(a.subjectId, day, 'background')

    const b = await userWith(2)
    await logEvent(prisma, b.id, 'consent_given', {}, { at: day })

    // Молчащий: вызовы есть (скажем, фоновая задача), действий нет — не DAU.
    const silent = await userWith(3)
    await call(silent.subjectId, day)

    // Участник команды: и действие, и вызов, но в зачёт не идёт.
    const team = await userWith(4)
    await prisma.teamSubject.create({ data: { subjectId: team.subjectId, kind: 'member' } })
    await logEvent(prisma, team.id, 'intent_submitted', { length_chars: 5, named_minutes: false }, { at: day })
    await call(team.subjectId, day)

    const rows = await prisma.$queryRaw<{ day_msk: string; dau: bigint; llm_calls: bigint; skill_calls: bigint; background_calls: bigint; calls_strict: bigint; calls_all: bigint }[]>`
      SELECT * FROM zachet_daily ORDER BY day_msk`
    expect(rows.map((r) => [r.day_msk, Number(r.dau), Number(r.llm_calls), Number(r.skill_calls), Number(r.background_calls), Number(r.calls_strict), Number(r.calls_all)])).toEqual([
      // a и b; у a два успешных вызова модели и одна фоновая задача.
      ['2026-11-02', 2, 2, 2, 1, 4, 5],
    ])
  })

  it('сверх дневного лимита модель не зовётся: действия не выполняются, событие — раз в сутки', async () => {
    let calls = 0
    const bot = makeBot({
      llm: provider(async (req) => {
        calls += 1
        return happyReply(req)
      }),
      stt: { enabled: true, model: 'test-stt', async transcribe() { return 'план главы' } },
    })
    await bot.setupOnboarded(A)
    const user = await prisma.user.findUniqueOrThrow({ where: { tgId: BigInt(A) } })
    await prisma.componentCall.createMany({
      data: Array.from({ length: LLM_CALLS_PER_DAY }, () => ({
        subjectId: user.subjectId, component: 'llm', name: 'tasks', skill: 'tasks', model: 'test-model',
        status: 'ok', latencyMs: 1, createdAt: new Date(bot.now().getTime() - 60 * 60_000),
      })),
    })

    await bot.text(A, 'набросать план главы, 30 минут')
    await bot.text(A, 'застрял')
    bot.tg.downloads.set('v', new Uint8Array([1]))
    await bot.voice(A, { fileId: 'v', duration: 3, mimeType: 'audio/ogg', fileSize: 1 })

    expect(calls).toBe(0)
    expect(await prisma.componentCall.count()).toBe(LLM_CALLS_PER_DAY)
    expect(await prisma.focusSession.count({ where: { userId: user.id, state: { in: ['running','paused','finished'] } } })).toBe(0)
    expect(await prisma.event.count({ where: { type: 'llm_budget_exceeded' } })).toBe(1)
    expect(bot.lastText(A)).toContain('напиши текстом')

    // Через сутки лимит снова свободен.
    bot.advance(24 * 60)
    await bot.text(A, 'застрял')
    expect(calls).toBeGreaterThan(0)
  })
})
