/*
  Warnings:

  - You are about to drop the `email_event` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "email_event" DROP CONSTRAINT "email_event_to_account_id_fkey";

-- DropTable
DROP TABLE "email_event";

-- CreateTable
CREATE TABLE "email_events" (
    "id" TEXT NOT NULL,
    "to_account_id" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "EventStatus" NOT NULL DEFAULT 'Pending',
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "failed_at" TIMESTAMP(3),
    "failed_reason" TEXT,
    "sent_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_events_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "email_events" ADD CONSTRAINT "email_events_to_account_id_fkey" FOREIGN KEY ("to_account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
