CREATE TABLE "task_time_allocations" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "task_id" TEXT NOT NULL,
    "seconds" INTEGER NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'report',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "task_time_allocations_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "task_time_allocations_seconds_check" CHECK ("seconds" >= 0)
);

CREATE UNIQUE INDEX "task_time_allocations_session_id_task_id_key"
ON "task_time_allocations"("session_id", "task_id");

CREATE INDEX "task_time_allocations_user_id_created_at_idx"
ON "task_time_allocations"("user_id", "created_at");

ALTER TABLE "task_time_allocations"
ADD CONSTRAINT "task_time_allocations_user_id_fkey"
FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "task_time_allocations"
ADD CONSTRAINT "task_time_allocations_session_id_fkey"
FOREIGN KEY ("session_id") REFERENCES "focus_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "task_time_allocations"
ADD CONSTRAINT "task_time_allocations_task_id_fkey"
FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
