ALTER TABLE "tasks" ADD COLUMN "drop_operation_id" UUID;
CREATE INDEX "tasks_user_id_drop_operation_id_idx" ON "tasks"("user_id", "drop_operation_id");
