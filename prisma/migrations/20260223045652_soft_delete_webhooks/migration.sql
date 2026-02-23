/*
  Warnings:

  - You are about to drop the column `iv` on the `files` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "files" DROP COLUMN "iv";

-- AlterTable
ALTER TABLE "webhook_endpoints" ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "subscribed_events" TEXT[];
