import { JobsOptions } from 'bullmq';

export enum QueueName {
  Webhooks = 'webhooks',
  Analytics = 'analytics',
  Emails = 'emails',
  Receipts = 'receipts',
}

export enum DLQName {
  WebhooksDLQ = 'webhooks.dlq',
  AnalyticsDLQ = 'analytics.dlq',
  EmailsDLQ = 'emails.dlq',
  ReceiptsDLQ = 'receipts.dlq',
}

export enum EventType {
  SendWebhooks = 'webhooks.send',
  TrackAnalytics = 'analytics.track',
  SendEmails = 'emails.send',
  GenerateReceipts = 'receipts.generate',
}

export function getQueueJobOptions(queueName: QueueName): JobsOptions {
  switch (queueName) {
    case QueueName.Webhooks:
      return {}; // open-circuit / respect Retry-After dynamically
    case QueueName.Emails:
      return {
        attempts: 10,
        backoff: { jitter: 0.5, type: 'exponential', delay: 5000 },
      };
    case QueueName.Receipts:
      return { attempts: 20, backoff: { type: 'fixed', delay: 5000 } };
    case QueueName.Analytics:
      return {
        attempts: 10,
        backoff: { jitter: 0.5, type: 'exponential', delay: 1000 },
      };
  }
}
