import { config } from './lib/config.js'
import { prisma } from './lib/db.js'
import { log } from './lib/log.js'
import { createWebhookServer } from './http/server.js'
import { handleUpdate } from './tg/webhook.js'
import { telegram } from './tg/client.js'
import { disabledProvider } from './llm/provider.js'
import { runOutboxOnce } from './outbox/worker.js'
import { startLoops } from './jobs/sweeper.js'
import type { Ctx } from './bot/context.js'

const cfg = config()

const ctx: Ctx = {
  db: prisma,
  tg: telegram,
  // Провайдер модели не выбран — оба касания идут детерминированным путём.
  llm: disabledProvider,
  now: () => new Date(),
  policyUrl: cfg.PRIVACY_POLICY_URL,
}

const server = createWebhookServer({
  secret: cfg.TELEGRAM_WEBHOOK_SECRET,
  path: cfg.TELEGRAM_WEBHOOK_PATH,
  onUpdate: (update) => handleUpdate(ctx, update),
})

startLoops(ctx, { outbox: () => runOutboxOnce(ctx) })

server.listen(cfg.PORT, () => {
  log.info('listening', { port: cfg.PORT })
})
