import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createWebhookServer, safeEqual } from './server.js'

const SECRET = 's'.repeat(40)
const PATH = 'p'.repeat(40)

async function start(onUpdate = vi.fn(async () => {})) {
  const server = createWebhookServer({ secret: SECRET, path: PATH, onUpdate })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return { server, onUpdate, base: `http://127.0.0.1:${port}` }
}

let current: Awaited<ReturnType<typeof start>> | null = null
afterEach(async () => {
  await new Promise((resolve) => current?.server.close(resolve) ?? resolve(null))
  current = null
})

describe('вебхук', () => {
  it('без правильного секрета — 401, тело не разобрано', async () => {
    current = await start()
    for (const headers of [{}, { 'x-telegram-bot-api-secret-token': 'wrong' }]) {
      const res = await fetch(`${current.base}/tg/${PATH}`, { method: 'POST', headers, body: '{"update_id":1}' })
      expect(res.status).toBe(401)
    }
    expect(current.onUpdate).not.toHaveBeenCalled()
  })

  it('с правильным секретом отдаёт апдейт в обработку', async () => {
    current = await start()
    const res = await fetch(`${current.base}/tg/${PATH}`, {
      method: 'POST',
      headers: { 'x-telegram-bot-api-secret-token': SECRET },
      body: '{"update_id":1}',
    })
    expect(res.status).toBe(200)
    await vi.waitFor(() => expect(current?.onUpdate).toHaveBeenCalledWith({ update_id: 1 }))
  })

  it('чужой путь — 404, не POST — 405', async () => {
    current = await start()
    expect((await fetch(`${current.base}/tg/${SECRET}`, { method: 'POST' })).status).toBe(404)
    expect((await fetch(`${current.base}/tg/${PATH}`)).status).toBe(405)
  })

  it('слишком большое тело не читается', async () => {
    current = await start()
    const res = await fetch(`${current.base}/tg/${PATH}`, {
      method: 'POST',
      headers: { 'x-telegram-bot-api-secret-token': SECRET },
      body: 'x'.repeat(1_100_000),
    })
    expect(res.status).toBe(413)
    expect(current.onUpdate).not.toHaveBeenCalled()
  })
})

describe('safeEqual', () => {
  it('сравнивает строки разной длины без исключения', () => {
    expect(safeEqual('abc', 'abc')).toBe(true)
    expect(safeEqual('abc', 'abcd')).toBe(false)
  })
})
