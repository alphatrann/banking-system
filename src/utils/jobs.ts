import { Prisma } from '@prisma/client';
import { EventType, QueueName } from '../queues/enums';
import { generateId } from './id';
import { WebhookEventType } from '../webhooks/enums';
import { TransactionWebhookPayload } from '../outbox/interfaces/job-payload';

export function buildSuccessOutboxJobs(
  transaction: TransactionWebhookPayload,
  receiptNumber: number,
  webhookEndpointIds: string[],
): Prisma.OutboxEventCreateManyInput[] {
  return [
    {
      id: generateId('obx'),
      aggregateId: `${transaction.id}:${EventType.GenerateReceipts}`,
      aggregateType: QueueName.Receipts,
      eventType: EventType.GenerateReceipts,
      payload: { transactionId: transaction.id, receiptNumber },
    },
    ...webhookEndpointIds.map((id) => {
      const eventId = generateId('evt');
      return {
        id: generateId('obx'),
        aggregateId: transaction.id,
        aggregateType: QueueName.Webhooks,
        eventType: WebhookEventType.TransferCompleted,
        payload: {
          endpointId: id,
          eventId,
          event: WebhookEventType.TransferCompleted,
          transaction: transaction as any,
        },
      };
    }),
  ];
}

export function buildFailureOutboxJobs(
  transaction: TransactionWebhookPayload,
  webhookEndpointIds: string[],
  statusCode: number,
  error: string,
): Prisma.OutboxEventCreateManyInput[] {
  const jobs = webhookEndpointIds.map((endpointId) => {
    const jobId = generateId('obx');
    const eventId = generateId('evt');
    return {
      id: jobId,
      aggregateId: transaction.id,
      aggregateType: QueueName.Webhooks,
      eventType: WebhookEventType.TransferFailed,
      payload: {
        endpointId,
        eventId,
        statusCode,
        error,
        transaction: transaction as any,
        event: WebhookEventType.TransferFailed,
      },
    };
  });

  return jobs;
}
