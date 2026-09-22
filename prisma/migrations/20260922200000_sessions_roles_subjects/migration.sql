-- DropForeignKey
ALTER TABLE "daily_goals" DROP CONSTRAINT "daily_goals_user_id_fkey";

-- DropForeignKey
ALTER TABLE "events" DROP CONSTRAINT "events_session_id_fkey";

-- DropForeignKey
ALTER TABLE "events" DROP CONSTRAINT "events_user_id_fkey";

-- DropForeignKey
ALTER TABLE "focus_sessions" DROP CONSTRAINT "focus_sessions_user_id_fkey";

-- DropForeignKey
ALTER TABLE "outbox_messages" DROP CONSTRAINT "outbox_messages_user_id_fkey";

-- DropForeignKey
ALTER TABLE "points_entries" DROP CONSTRAINT "points_entries_user_id_fkey";

-- DropForeignKey
ALTER TABLE "streaks" DROP CONSTRAINT "streaks_user_id_fkey";

-- DropForeignKey
ALTER TABLE "tasks" DROP CONSTRAINT "tasks_user_id_fkey";

-- DropIndex
DROP INDEX "events_day_key_user_id_idx";

-- DropIndex
DROP INDEX "events_user_id_created_at_idx";

-- DropIndex
DROP INDEX "focus_sessions_user_id_started_at_idx";

-- DropIndex
DROP INDEX "outbox_messages_sent_at_send_after_idx";

-- AlterTable
ALTER TABLE "daily_goals" ADD COLUMN     "goal_reached_at" TIMESTAMP(3),
ADD COLUMN     "summary_sent_at" TIMESTAMP(3),
ALTER COLUMN "target_sessions" DROP NOT NULL,
ALTER COLUMN "target_sessions" DROP DEFAULT;


-- AlterTable
ALTER TABLE "focus_sessions" ADD COLUMN     "abandon_reason" TEXT,
ADD COLUMN     "counted" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "intent_text" TEXT,
ADD COLUMN     "minutes_adjusted" TEXT,
ADD COLUMN     "minutes_source" TEXT,
ADD COLUMN     "pings_missed" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "planned_end_at" TIMESTAMP(3),
ADD COLUMN     "planned_rest_minutes" INTEGER,
ADD COLUMN     "rest_choice" TEXT,
ADD COLUMN     "rest_ended_at" TIMESTAMP(3),
ADD COLUMN     "scope" TEXT,
ADD COLUMN     "state" TEXT NOT NULL DEFAULT 'collecting_intent',
ADD COLUMN     "technique" TEXT,
ALTER COLUMN "started_at" DROP NOT NULL,
ALTER COLUMN "started_at" DROP DEFAULT,
ALTER COLUMN "planned_minutes" DROP NOT NULL,
ALTER COLUMN "planned_minutes" DROP DEFAULT,
ALTER COLUMN "outcome" DROP NOT NULL,
ALTER COLUMN "outcome" DROP DEFAULT;

-- Старый outcome (running | completed | abandoned) превращается в состояние
-- автомата. Исход старых завершённых сессий неизвестен — other, а не done:
-- приписывать людям сделанное задним числом нельзя.
UPDATE "focus_sessions" SET "created_at" = COALESCE("started_at", "created_at");
UPDATE "focus_sessions" SET "state" = 'running', "outcome" = NULL WHERE "outcome" = 'running';
UPDATE "focus_sessions" SET "state" = 'finished', "outcome" = 'other' WHERE "outcome" = 'completed';
UPDATE "focus_sessions" SET "state" = 'abandoned', "outcome" = NULL WHERE "outcome" = 'abandoned';

-- AlterTable
ALTER TABLE "outbox_messages" ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'pending';

-- AlterTable
ALTER TABLE "tasks" ADD COLUMN     "last_session_at" TIMESTAMP(3),
ADD COLUMN     "next_step" TEXT,
ADD COLUMN     "sessions_since_progress" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "consent_at" TIMESTAMP(3),
ADD COLUMN     "counted_sessions" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "declines_in_row" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "evening_time" TEXT NOT NULL DEFAULT '21:00',
ADD COLUMN     "last_user_action_at" TIMESTAMP(3),
ADD COLUMN     "morning_time" TEXT NOT NULL DEFAULT '10:00',
ADD COLUMN     "pending_input" TEXT NOT NULL DEFAULT 'none',
ADD COLUMN     "pings_enabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "proactive" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "profile_text" TEXT,
ADD COLUMN     "ritual_text" TEXT,
ADD COLUMN     "role" TEXT NOT NULL DEFAULT 'new',
ADD COLUMN     "subject_id" TEXT,
ADD COLUMN     "technique" TEXT NOT NULL DEFAULT 'auto';

-- Псевдоним в журнале: случайный, не выводится из id. Заполняем существующим
-- пользователям до того, как на него переедут события.
UPDATE "users" SET "subject_id" = gen_random_uuid()::text WHERE "subject_id" IS NULL;
ALTER TABLE "users" ALTER COLUMN "subject_id" SET NOT NULL;

-- CreateTable
CREATE TABLE "role_transitions" (
    "id" BIGSERIAL NOT NULL,
    "subject_id" TEXT NOT NULL,
    "from_role" TEXT NOT NULL,
    "to_role" TEXT NOT NULL,
    "day_key" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "role_transitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rate_limits" (
    "tg_id" BIGINT NOT NULL,
    "window_start" TIMESTAMP(3) NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "rate_limits_pkey" PRIMARY KEY ("tg_id","window_start")
);

-- CreateTable
CREATE TABLE "relationships" (
    "id" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "viewer_id" TEXT NOT NULL,
    "level" TEXT NOT NULL DEFAULT 'watcher',
    "partner_confirmed_by_owner_at" TIMESTAMP(3),
    "partner_confirmed_by_viewer_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "relationships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invite_tokens" (
    "id" TEXT NOT NULL,
    "inviter_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "level" TEXT NOT NULL DEFAULT 'watcher',
    "expires_at" TIMESTAMP(3) NOT NULL,
    "max_uses" INTEGER NOT NULL DEFAULT 1,
    "uses" INTEGER NOT NULL DEFAULT 0,
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invite_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "role_transitions_subject_id_created_at_idx" ON "role_transitions"("subject_id", "created_at");

-- CreateIndex
CREATE INDEX "rate_limits_window_start_idx" ON "rate_limits"("window_start");

-- CreateIndex
CREATE INDEX "relationships_viewer_id_idx" ON "relationships"("viewer_id");

-- CreateIndex
CREATE UNIQUE INDEX "relationships_owner_id_viewer_id_key" ON "relationships"("owner_id", "viewer_id");

-- CreateIndex
CREATE UNIQUE INDEX "invite_tokens_token_hash_key" ON "invite_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "invite_tokens_inviter_id_idx" ON "invite_tokens"("inviter_id");

-- CreateIndex
CREATE INDEX "focus_sessions_user_id_created_at_idx" ON "focus_sessions"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "focus_sessions_state_planned_end_at_idx" ON "focus_sessions"("state", "planned_end_at");

-- CreateIndex
CREATE INDEX "outbox_messages_status_send_after_idx" ON "outbox_messages"("status", "send_after");

-- CreateIndex
CREATE INDEX "outbox_messages_user_id_status_idx" ON "outbox_messages"("user_id", "status");

-- CreateIndex
CREATE INDEX "points_entries_user_id_reason_created_at_idx" ON "points_entries"("user_id", "reason", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "users_subject_id_key" ON "users"("subject_id");

-- CreateIndex
CREATE INDEX "users_role_last_user_action_at_idx" ON "users"("role", "last_user_action_at");

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "focus_sessions" ADD CONSTRAINT "focus_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outbox_messages" ADD CONSTRAINT "outbox_messages_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "daily_goals" ADD CONSTRAINT "daily_goals_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "streaks" ADD CONSTRAINT "streaks_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "points_entries" ADD CONSTRAINT "points_entries_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "relationships" ADD CONSTRAINT "relationships_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "relationships" ADD CONSTRAINT "relationships_viewer_id_fkey" FOREIGN KEY ("viewer_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invite_tokens" ADD CONSTRAINT "invite_tokens_inviter_id_fkey" FOREIGN KEY ("inviter_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- События переезжают с user_id на псевдоним. Существующим проставляем роль new:
-- до этой миграции ролей не было, а первые события — это /start.
ALTER TABLE "events" ADD COLUMN "subject_id" TEXT, ADD COLUMN "user_role" TEXT;
UPDATE "events" e SET "subject_id" = u."subject_id" FROM "users" u WHERE u."id" = e."user_id";
UPDATE "events" SET "user_role" = 'new' WHERE "user_role" IS NULL;
ALTER TABLE "events" DROP COLUMN "user_id";
ALTER TABLE "events" ALTER COLUMN "subject_id" SET NOT NULL, ALTER COLUMN "user_role" SET NOT NULL;

CREATE INDEX "events_day_key_subject_id_idx" ON "events"("day_key", "subject_id");
CREATE INDEX "events_subject_id_created_at_idx" ON "events"("subject_id", "created_at");

-- Ровно одна активная сессия на пользователя. Частичный уникальный индекс, а не
-- проверка в коде: два одновременных /focus иначе создали бы две сессии. Prisma
-- такие индексы в схеме не описывает, поэтому он живёт только здесь.
CREATE UNIQUE INDEX "focus_sessions_one_active_per_user"
  ON "focus_sessions"("user_id") WHERE "state" IN ('collecting_intent', 'running');

-- Журнал событий и история ролей — только дозапись. Запрет в базе, а не в коде:
-- метрики проверяет антифрод, и «поправить задним числом» не должно быть
-- возможно даже по ошибке. TRUNCATE намеренно не закрыт — это административная
-- операция (чистка тестовой базы), а не путь, которым ходит приложение.
CREATE FUNCTION forbid_journal_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'журнал % только на дозапись', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER events_append_only BEFORE UPDATE OR DELETE ON "events"
  FOR EACH ROW EXECUTE FUNCTION forbid_journal_change();
CREATE TRIGGER role_transitions_append_only BEFORE UPDATE OR DELETE ON "role_transitions"
  FOR EACH ROW EXECUTE FUNCTION forbid_journal_change();
