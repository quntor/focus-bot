import { beforeEach, describe, expect, it } from 'vitest'
import { hasDb, prisma, resetDb } from '../test/db.js'
import { makeBot } from '../test/bot.js'
import { LlmCallError, type LlmProvider, type LlmReply } from '../llm/provider.js'
import { logEvent } from './log.js'

const A = 7001

function provider(reply: () => Promise<LlmReply>): LlmProvider {
  return { enabled: true, model: 'test-model', complete: reply }
}

const intentOk = JSON.stringify({ task: null, title: 'план главы', scope: 'step' })
const reportOk = JSON.stringify({ progress: 'moved', next_step: 'дописать введение' })

describe.skipIf(!hasDb)('журнал вызовов компонентов', () => {
  beforeEach(resetDb)

  it('каждый реальный вызов модели — строка с касанием, skill, статусом и токенами', async () => {
    const answers = [intentOk, reportOk]
    const bot = makeBot({ llm: provider(async () => ({ text: answers.shift()!, usage: { inputTokens: 120, outputTokens: 30 } })) })
    await bot.onboard(A)
    await bot.text(A, 'набросать план главы, 30 минут')
    const s = await prisma.focusSession.findFirstOrThrow()
    bot.advance(30)
    await bot.press(A, `out:${s.id}:done`)
    await bot.text(A, 'план готов, осталось введение')

    const user = await prisma.user.findUniqueOrThrow({ where: { tgId: BigInt(A) } })
    const calls = await prisma.componentCall.findMany({ orderBy: { id: 'asc' } })
    expect(calls.map((c) => [c.component, c.name, c.skill, c.status, c.errorCode, c.inputTokens, c.outputTokens])).toEqual([
      ['llm', 'intent', 'intent', 'ok', null, 120, 30],
      ['llm', 'report', 'report', 'ok', null, 120, 30],
    ])
    expect(calls.every((c) => c.subjectId === user.subjectId && c.sessionId === s.id && c.model === 'test-model')).toBe(true)
  })

  it('текст пользователя в журнал вызовов не попадает', async () => {
    const bot = makeBot({ llm: provider(async () => ({ text: intentOk, usage: null })) })
    await bot.onboard(A)
    await bot.text(A, 'секретный проект Альфа, 30 минут')
    const rows = await prisma.$queryRaw<Record<string, unknown>[]>`SELECT * FROM component_calls`
    expect(rows).toHaveLength(1)
    expect(JSON.stringify(rows, (_k, v) => (typeof v === 'bigint' ? Number(v) : v))).not.toContain('Альфа')
  })

  it('отказы пишутся со статусом и машинным кодом, fallback работает', async () => {
    const cases: [() => Promise<LlmReply>, string, string][] = [
      [async () => ({ text: 'не JSON', usage: null }), 'invalid', 'not_json'],
      [async () => ({ text: JSON.stringify({ task: null, title: 'x', scope: 'step', points: 1000 }), usage: null }), 'invalid', 'schema'],
      [async () => { throw new LlmCallError('LLM request failed (HTTP 402)', 'http_402') }, 'error', 'http_402'],
      [async () => { throw new Error('что-то своё') }, 'error', 'error'],
    ]
    let tg = A
    for (const [reply, status, code] of cases) {
      await resetDb()
      const bot = makeBot({ llm: provider(reply) })
      await bot.onboard(++tg)
      await bot.text(tg, 'план главы, 30 минут')
      const call = await prisma.componentCall.findFirstOrThrow()
      expect([call.status, call.errorCode]).toEqual([status, code])
      expect((await prisma.focusSession.findFirstOrThrow()).state).toBe('running')
    }
  })

  it('выключенная модель вызова не делает — и строки нет', async () => {
    const bot = makeBot()
    await bot.onboard(A)
    await bot.text(A, 'план главы, 30 минут')
    expect(await prisma.componentCall.count()).toBe(0)
  })

  it('журнал вызовов только на дозапись', async () => {
    const bot = makeBot({ llm: provider(async () => ({ text: intentOk, usage: null })) })
    await bot.onboard(A)
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
})
