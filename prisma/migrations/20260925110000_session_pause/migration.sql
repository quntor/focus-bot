-- AlterTable
ALTER TABLE "focus_sessions"
ADD COLUMN "paused_at" TIMESTAMP(3),
ADD COLUMN "paused_seconds" INTEGER NOT NULL DEFAULT 0;

-- Paused is still an active session: a second /focus must not create a parallel one.
DROP INDEX "focus_sessions_one_active_per_user";
CREATE UNIQUE INDEX "focus_sessions_one_active_per_user"
  ON "focus_sessions"("user_id") WHERE "state" IN ('collecting_intent', 'running', 'paused');
