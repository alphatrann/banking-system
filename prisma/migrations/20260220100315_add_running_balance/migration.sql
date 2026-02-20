/*
 Warnings:
 
 - The primary key for the `ledger_entries` table will be changed. If it partially fails, the table could be left without primary key constraint.
 - The `id` column on the `ledger_entries` table would be dropped and recreated. This will lead to data loss if there is data in the column.
 - You are about to drop the `outbox_event` table. If the table is not empty, all the data it contains will be lost.
 
 */
-- AlterTable
ALTER TABLE "ledger_entries" DROP CONSTRAINT "ledger_entries_pkey",
  ADD COLUMN "running_balance" BIGINT CHECK ("running_balance" >= 0),
  DROP COLUMN "id",
  ADD COLUMN "id" SERIAL NOT NULL,
  ADD CONSTRAINT "ledger_entries_pkey" PRIMARY KEY ("id");
-- DropTable
DROP TABLE "outbox_event";
-- CreateTable
CREATE TABLE "outbox_events" (
  "id" TEXT NOT NULL,
  "aggregate_type" TEXT NOT NULL,
  "aggregate_id" TEXT NOT NULL,
  "event_type" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "status" "OutboxEventStatus" NOT NULL DEFAULT 'Pending',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "processed_at" TIMESTAMP(3),
  CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);