import { createHash, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { log } from '../lib/log.js'

// Апдейт Telegram — килобайты. Мегабайт с запасом покрывает любое сообщение и
// не даёт забить память тем, кто нашёл адрес.
export const MAX_BODY_BYTES = 1_000_000

type Options = {
  secret: string
  path: string
  onUpdate: (update: unknown) => Promise<void>
}

// Сравнение за постоянное время. Хэшируем обе строки, чтобы длины совпадали:
// timingSafeEqual на разной длине бросает, а ранний выход по длине сам по себе
// подсказывает длину секрета.
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest()
  const hb = createHash('sha256').update(b).digest()
  return timingSafeEqual(ha, hb)
}

class BodyTooLarge extends Error {
  override name = 'BodyTooLarge'
}

async function readBody(req: IncomingMessage): Promise<string> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > MAX_BODY_BYTES) throw new BodyTooLarge()
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

export function createWebhookServer(opts: Options): Server {
  const webhookPath = `/tg/${opts.path}`

  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok')
      return
    }

    if (req.url !== webhookPath) {
      res.writeHead(404).end()
      return
    }
    if (req.method !== 'POST') {
      res.writeHead(405).end()
      return
    }

    // Секрет проверяется до чтения тела: чужой запрос не разбирается и не
    // логируется вовсе, даже частично.
    const header = req.headers['x-telegram-bot-api-secret-token']
    if (typeof header !== 'string' || !safeEqual(header, opts.secret)) {
      res.writeHead(401).end()
      req.resume()
      return
    }

    const declared = Number(req.headers['content-length'] ?? 0)
    if (declared > MAX_BODY_BYTES) {
      res.writeHead(413).end()
      req.resume()
      return
    }

    void readBody(req)
      .then((body) => {
        let update: unknown
        try {
          update = JSON.parse(body)
        } catch {
          // Сообщение SyntaxError цитирует кусок тела — не логируем его.
          log.warn('webhook_bad_json')
          res.writeHead(400).end()
          return
        }
        // Telegram считает апдейт доставленным по коду ответа и повторяет его при
        // любом другом. Отвечаем сразу, а обработку доводим в фоне: медленный
        // ответ модели не должен превращаться в повторную доставку. Дубли всё
        // равно отсекает таблица processed_updates.
        res.writeHead(200).end()
        return opts.onUpdate(update).catch((error: unknown) => log.error('update_failed', error))
      })
      .catch((error: unknown) => {
        if (error instanceof BodyTooLarge) {
          if (!res.headersSent) res.writeHead(413).end()
          req.destroy()
          return
        }
        log.error('webhook_read_failed', error)
        if (!res.headersSent) res.writeHead(400).end()
      })
  })

  // Медленный клиент не должен держать соединение: заголовки за 5 секунд,
  // весь запрос за 10. Telegram укладывается в это с большим запасом.
  server.headersTimeout = 5_000
  server.requestTimeout = 10_000
  return server
}
