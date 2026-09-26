import { config } from './lib/config.js'
import { prisma } from './lib/db.js'
import { log } from './lib/log.js'
import { createWebhookServer } from './http/server.js'
import { handleUpdate } from './tg/webhook.js'
import { telegram } from './tg/client.js'
import { disabledProvider } from './llm/provider.js'
import { createOpenAiCompatibleProvider } from './llm/openai-compatible.js'
import { runOutboxOnce } from './outbox/worker.js'
import { startLoops } from './jobs/sweeper.js'
import type { Ctx } from './bot/context.js'
import { disabledSttProvider } from './stt/provider.js'
import { createOpenAiCompatibleSttProvider } from './stt/openai-compatible.js'

const cfg = config()
const llm =
  cfg.LLM_API_KEY && cfg.LLM_BASE_URL && cfg.LLM_MODEL
    ? createOpenAiCompatibleProvider({ apiKey: cfg.LLM_API_KEY, baseUrl: cfg.LLM_BASE_URL, model: cfg.LLM_MODEL })
    : disabledProvider
const stt =
  cfg.LLM_API_KEY && cfg.LLM_BASE_URL && cfg.STT_MODEL
    ? createOpenAiCompatibleSttProvider({ apiKey: cfg.LLM_API_KEY, baseUrl: cfg.LLM_BASE_URL, model: cfg.STT_MODEL })
    : disabledSttProvider

const ctx: Ctx = {
  db: prisma,
  tg: telegram,
  llm,
  stt,
  now: () => new Date(),
  policyUrl: cfg.PRIVACY_POLICY_URL,
}

const server = createWebhookServer({
  secret: cfg.TELEGRAM_WEBHOOK_SECRET,
  path: cfg.TELEGRAM_WEBHOOK_PATH,
  onUpdate: (update) => handleUpdate(ctx, update),
  privacy: cfg.PRIVACY_OPERATOR_NAME && cfg.PRIVACY_CONTACT_EMAIL
    ? { operatorName: cfg.PRIVACY_OPERATOR_NAME, contactEmail: cfg.PRIVACY_CONTACT_EMAIL }
    : undefined,
})

startLoops(ctx, { outbox: () => runOutboxOnce(ctx) })

server.listen(cfg.PORT, () => {
  log.info('listening', { port: cfg.PORT })
})
