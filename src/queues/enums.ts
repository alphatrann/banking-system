export enum QueueName {
  Webhooks = 'webhooks',
  Analytics = 'analytics',
  Emails = 'emails',
  Receipts = 'receipts',
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

export function getEventQueue(eventType: EventType, isDLQ = false) {
  switch (eventType) {
    case EventType.GenerateReceipts:
      return isDLQ ? QueueName.ReceiptsDLQ : QueueName.Receipts;
    case EventType.SendEmails:
      return isDLQ ? QueueName.EmailsDLQ : QueueName.Emails;
    case EventType.SendWebhooks:
      return isDLQ ? QueueName.WebhooksDLQ : QueueName.Webhooks;
    case EventType.TrackAnalytics:
      return isDLQ ? QueueName.AnalyticsDLQ : QueueName.Analytics;
  }
}
