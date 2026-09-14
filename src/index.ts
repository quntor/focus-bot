import { createServer, type IncomingMessage } from 'node:http'
import { config } from './lib/config.js'
import { handleUpdate } from './tg/webhook.js'

const MAX_BODY_BYTES = 1_000_000

async function readBody(req: IncomingMessage): Promise<string> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('тело запроса слишком большое')
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

const cfg = config()
const webhookPath = `/tg/${cfg.TELEGRAM_WEBHOOK_SECRET}`

const server = createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok')
    return
  }

  if (req.method !== 'POST' || req.url !== webhookPath) {
    res.writeHead(404).end()
    return
  }

  // Секрет в пути легко утекает в логи прокси, поэтому Telegram дополнительно
  // присылает его заголовком — проверяем оба.
  if (req.headers['x-telegram-bot-api-secret-token'] !== cfg.TELEGRAM_WEBHOOK_SECRET) {
    res.writeHead(401).end()
    return
  }

  void readBody(req)
    .then((body) => {
      // Telegram считает апдейт доставленным по коду ответа и повторяет его при
      // любом другом. Отвечаем сразу, а обработку доводим в фоне: медленный
      // ответ модели не должен превращаться в повторную доставку и второй ответ
      // пользователю.
      res.writeHead(200).end()
      return handleUpdate(JSON.parse(body))
    })
    .catch((error: unknown) => {
      console.error('webhook:', error)
      if (!res.writableEnded) res.writeHead(200).end()
    })
})

server.listen(cfg.PORT, () => {
  console.log(`focus-bot слушает :${cfg.PORT}`)
})
