import { Prisma } from '@prisma/client';
import { EventType, QueueName } from '../queues/enums';
import { generateId } from './id';
import { WebhookEventType } from '../webhooks/enums';
import { TransactionWebhookPayload } from '../outbox/interfaces/job-payload';

export function buildSuccessOutboxJobs(
  transaction: TransactionWebhookPayload,
  receiptNumber: number,
  webhookEndpointIds: string[],
  carrier: Record<string, string>,
): Prisma.OutboxEventCreateManyInput[] {
  return [
    {
      id: generateId('obx'),
      aggregateId: transaction.id,
      aggregateType: 'Transaction',
      eventType: EventType.GenerateReceipts,
      traceContext: carrier,
      payload: { transactionId: transaction.id, receiptNumber },
    },
    ...webhookEndpointIds.map((id) => {
      const eventId = generateId('evt');
      return {
        id: generateId('obx'),
        aggregateId: `${transaction.id}:${id}`,
        aggregateType: 'Transaction',
        traceContext: carrier,
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
  carrier: Record<string, string>,
): Prisma.OutboxEventCreateManyInput[] {
  const jobs = webhookEndpointIds.map((endpointId) => {
    const jobId = generateId('obx');
    const eventId = generateId('evt');
    return {
      id: jobId,
      aggregateId: transaction.id,
      traceContext: carrier,
      aggregateType: 'Transaction',
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
