ALTER TABLE "focus_sessions"
ADD COLUMN "continue_minutes" INTEGER;

ALTER TABLE "focus_sessions"
ADD CONSTRAINT "focus_sessions_continue_minutes_check"
CHECK ("continue_minutes" IS NULL OR ("continue_minutes" >= 1 AND "continue_minutes" <= 1440));
