ALTER TABLE "users" ADD COLUMN "default_work_minutes" INTEGER, ADD COLUMN "default_rest_minutes" INTEGER;
ALTER TABLE "users" ADD CONSTRAINT "users_work_minutes_range" CHECK (default_work_minutes BETWEEN 10 AND 240), ADD CONSTRAINT "users_rest_minutes_range" CHECK (default_rest_minutes BETWEEN 1 AND 240);
