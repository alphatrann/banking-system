-- AlterEnum
ALTER TYPE "OutboxEventStatus" ADD VALUE 'Failed';

-- AlterTable
ALTER TABLE "outbox_events" ADD COLUMN     "attempt_count" INTEGER NOT NULL DEFAULT 0;
