ALTER TABLE "users" ADD COLUMN "notification_days" INTEGER NOT NULL DEFAULT 127;
ALTER TABLE "users" ADD CONSTRAINT "users_notification_days_check" CHECK ("notification_days" BETWEEN 0 AND 127);
