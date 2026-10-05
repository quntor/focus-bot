-- AlterTable
ALTER TABLE "users" ADD COLUMN     "quiet_until" TIMESTAMP(3),
ADD COLUMN     "reminder_policy" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "send_gate_token" TEXT,
ADD COLUMN     "send_gate_until" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "focus_sessions" ADD COLUMN     "reminder_policy" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "outbox_messages" ADD COLUMN     "chain_id" TEXT,
ADD COLUMN     "chain_revision" INTEGER,
ADD COLUMN     "context_fingerprint" TEXT,
ADD COLUMN     "generated_text" TEXT,
ADD COLUMN     "generation_status" TEXT,
ADD COLUMN     "generation_token" TEXT,
ADD COLUMN     "ordinal" INTEGER,
ADD COLUMN     "provenance" TEXT,
ADD COLUMN     "send_attempt_started_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "calendar_plans" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "local_date" TEXT NOT NULL,
    "answer" TEXT NOT NULL,
    "answered_at" TIMESTAMP(3) NOT NULL,
    "source" TEXT NOT NULL,

    CONSTRAINT "calendar_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reminder_chains" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "session_id" TEXT,
    "local_date" TEXT,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "phase_started_at" TIMESTAMP(3) NOT NULL,
    "first_due_at" TIMESTAMP(3) NOT NULL,
    "interval_minutes" INTEGER NOT NULL,
    "rest_step" INTEGER NOT NULL DEFAULT 0,
    "ordinal" INTEGER NOT NULL DEFAULT 0,
    "next_due_at" TIMESTAMP(3) NOT NULL,
    "delivery_anchor_at" TIMESTAMP(3),
    "night_until" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'active',
    "policy_version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "reminder_chains_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "work_periods" (
    "id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL,
    "ended_at" TIMESTAMP(3),
    "correction_id" TEXT,

    CONSTRAINT "work_periods_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "calendar_plans_user_id_local_date_key" ON "calendar_plans"("user_id", "local_date");

-- CreateIndex
CREATE INDEX "reminder_chains_status_next_due_at_idx" ON "reminder_chains"("status", "next_due_at");

-- CreateIndex
CREATE INDEX "work_periods_session_id_started_at_idx" ON "work_periods"("session_id", "started_at");

-- CreateIndex
CREATE UNIQUE INDEX "outbox_messages_chain_id_chain_revision_ordinal_key" ON "outbox_messages"("chain_id", "chain_revision", "ordinal");

-- AddForeignKey
ALTER TABLE "outbox_messages" ADD CONSTRAINT "outbox_messages_chain_id_fkey" FOREIGN KEY ("chain_id") REFERENCES "reminder_chains"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calendar_plans" ADD CONSTRAINT "calendar_plans_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reminder_chains" ADD CONSTRAINT "reminder_chains_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reminder_chains" ADD CONSTRAINT "reminder_chains_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "focus_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_periods" ADD CONSTRAINT "work_periods_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "focus_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE UNIQUE INDEX "reminder_chains_one_active" ON "reminder_chains" ("user_id") WHERE "status" = 'active';
CREATE UNIQUE INDEX "work_periods_one_open" ON "work_periods" ("session_id") WHERE "ended_at" IS NULL;

ALTER TABLE "work_periods" ADD COLUMN "original_ended_at" TIMESTAMP(3);
