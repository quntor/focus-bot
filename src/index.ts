import { config } from './lib/config.js'
import { log } from './lib/log.js'
import { createWebhookServer } from './http/server.js'
import { handleUpdate } from './tg/webhook.js'

const cfg = config()

const server = createWebhookServer({
  secret: cfg.TELEGRAM_WEBHOOK_SECRET,
  path: cfg.TELEGRAM_WEBHOOK_PATH,
  onUpdate: handleUpdate,
})

server.listen(cfg.PORT, () => {
  log.info('listening', { port: cfg.PORT })
})
