/*
  Warnings:

  - You are about to drop the column `original_name` on the `files` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[bucket,object]` on the table `files` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "files" DROP COLUMN "original_name";

-- CreateIndex
CREATE UNIQUE INDEX "files_bucket_object_key" ON "files"("bucket", "object");
