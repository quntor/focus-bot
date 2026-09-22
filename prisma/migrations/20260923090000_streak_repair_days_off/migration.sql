-- AlterTable
ALTER TABLE "streaks" ADD COLUMN     "last_repair_day" TEXT,
ADD COLUMN     "repair_from" INTEGER,
ADD COLUMN     "repair_until" TEXT;

-- CreateTable
CREATE TABLE "days_off" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "day_key" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "days_off_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "days_off_user_id_day_key_key" ON "days_off"("user_id", "day_key");

-- AddForeignKey
ALTER TABLE "days_off" ADD CONSTRAINT "days_off_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

