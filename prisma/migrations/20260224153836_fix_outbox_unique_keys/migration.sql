/*
  Warnings:

  - A unique constraint covering the columns `[aggregate_id,event_type]` on the table `outbox_events` will be added. If there are existing duplicate values, this will fail.

*/
-- DropIndex
DROP INDEX "outbox_events_aggregate_type_aggregate_id_key";

-- CreateIndex
CREATE UNIQUE INDEX "outbox_events_aggregate_id_event_type_key" ON "outbox_events"("aggregate_id", "event_type");
