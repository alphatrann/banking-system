/*
  Warnings:

  - You are about to drop the column `attempt_count` on the `email_events` table. All the data in the column will be lost.
  - You are about to drop the column `failed_reason` on the `email_events` table. All the data in the column will be lost.
  - You are about to drop the column `failed_reason` on the `receipts` table. All the data in the column will be lost.
  - You are about to drop the column `secret` on the `webhook_endpoints` table. All the data in the column will be lost.
  - You are about to drop the column `attempt_count` on the `webhook_events` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[url,account_id]` on the table `webhook_endpoints` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `encryption_algorithm` to the `files` table without a default value. This is not possible if the table is not empty.
  - Added the required column `iv` to the `files` table without a default value. This is not possible if the table is not empty.
  - Added the required column `encryptedSecret` to the `webhook_endpoints` table without a default value. This is not possible if the table is not empty.
  - Added the required column `encryption_algorithm` to the `webhook_endpoints` table without a default value. This is not possible if the table is not empty.
  - Added the required column `iv` to the `webhook_endpoints` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "email_events" DROP COLUMN "attempt_count",
DROP COLUMN "failed_reason",
ADD COLUMN     "error" TEXT;

-- AlterTable
ALTER TABLE "files" ADD COLUMN     "auth_tag" TEXT,
ADD COLUMN     "encryption_algorithm" TEXT NOT NULL,
ADD COLUMN     "iv" TEXT NOT NULL,
ADD COLUMN     "key_version" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "receipts" DROP COLUMN "failed_reason",
ADD COLUMN     "error" TEXT;

-- AlterTable
ALTER TABLE "webhook_endpoints" DROP COLUMN "secret",
ADD COLUMN     "auth_tag" TEXT,
ADD COLUMN     "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "encryptedSecret" TEXT NOT NULL,
ADD COLUMN     "encryption_algorithm" TEXT NOT NULL,
ADD COLUMN     "iv" TEXT NOT NULL,
ADD COLUMN     "key_version" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "webhook_events" DROP COLUMN "attempt_count";

-- CreateIndex
CREATE UNIQUE INDEX "webhook_endpoints_url_account_id_key" ON "webhook_endpoints"("url", "account_id");
