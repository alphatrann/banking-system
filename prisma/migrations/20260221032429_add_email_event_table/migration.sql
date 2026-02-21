/*
  Warnings:

  - The `status` column on the `webhook_events` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - A unique constraint covering the columns `[aggregate_id,event_type]` on the table `outbox_events` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateEnum
CREATE TYPE "EventStatus" AS ENUM ('Pending', 'Delivered', 'Failed');

-- AlterEnum
ALTER TYPE "OutboxEventStatus" ADD VALUE 'Processing';

-- AlterTable
ALTER TABLE "outbox_events" ADD COLUMN     "next_retry_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "webhook_events" DROP COLUMN "status",
ADD COLUMN     "status" "EventStatus" NOT NULL DEFAULT 'Pending';

-- DropEnum
DROP TYPE "WebhookEventStatus";

-- CreateTable
CREATE TABLE "EmailEvent" (
    "id" TEXT NOT NULL,
    "to_account_id" TEXT NOT NULL,
    "receipt_id" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "EventStatus" NOT NULL DEFAULT 'Pending',
    "next_retry_at" TIMESTAMP(3),
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "sentAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "outbox_events_aggregate_id_event_type_key" ON "outbox_events"("aggregate_id", "event_type");

-- AddForeignKey
ALTER TABLE "EmailEvent" ADD CONSTRAINT "EmailEvent_to_account_id_fkey" FOREIGN KEY ("to_account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailEvent" ADD CONSTRAINT "EmailEvent_receipt_id_fkey" FOREIGN KEY ("receipt_id") REFERENCES "receipts"("file_id") ON DELETE RESTRICT ON UPDATE CASCADE;
