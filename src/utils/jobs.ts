import { Prisma } from '@prisma/client';
import { EventType, QueueName } from '../queues/enums';
import { generateId } from './id';

export function buildSuccessOutboxJobs(
  transactionId: string,
  receiptNumber: number,
): Prisma.OutboxEventCreateManyInput[] {
  const receiptId = generateId('rec');

  return [
    {
      id: receiptId,
      aggregateId: `${transactionId}:${EventType.GenerateReceipts}`,
      aggregateType: QueueName.Receipts,
      eventType: EventType.GenerateReceipts,
      payload: { transactionId, receiptNumber },
    },
  ];
}

export function buildFailureOutboxJobs(): Prisma.OutboxEventCreateManyInput[] {
  // TODO: add analytics tracking = email sending + webhook jobs
  const jobs = [];

  return jobs;
}
