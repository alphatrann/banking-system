import { JobsOptions } from 'bullmq';

export enum QueueName {
  Webhooks = 'webhooks',
  Emails = 'emails',
  Receipts = 'receipts',
}

export enum DLQName {
  WebhooksDLQ = 'webhooks.dlq',
  EmailsDLQ = 'emails.dlq',
  ReceiptsDLQ = 'receipts.dlq',
}

export enum EventType {
  SendEmails = 'emails.send',
  GenerateReceipts = 'receipts.generate',
}

export function getQueueJobOptions(queueName: QueueName): JobsOptions {
  switch (queueName) {
    case QueueName.Webhooks:
      return { attempts: 20, backoff: { type: 'custom' } };
    case QueueName.Emails:
      return {
        attempts: 10,
        backoff: { jitter: 0.5, type: 'exponential', delay: 5000 },
      };
    case QueueName.Receipts:
      return { attempts: 20, backoff: { type: 'fixed', delay: 5000 } };
  }
}
