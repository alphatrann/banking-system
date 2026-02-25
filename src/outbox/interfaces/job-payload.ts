import { WebhookEventType } from '../../webhooks/enums';

export interface JobPayload {
  transactionId?: string;
  _trace: Record<string, string> | null;
}

export interface TrackAnalyticsJobPayload extends JobPayload {
  requestTime: number;
  responseTime: number;
  statusCode: number;
}

export interface GenerateReceiptJobPayload extends JobPayload {
  receiptNumber: number;
}

export interface SendEmailJobPayload extends JobPayload {
  sendEmailAccountId: string;
  receiptId: string;
}

export interface TransactionWebhookPayload {
  id: string;
  amount: number;
  toAccountId: string;
  fromAccountId: string;
  currency: 'USD';
  occurredAt: string;
}

export type SendWebhookJobPayload = { endpointId: string; eventId: string } & (
  | {
      event: WebhookEventType.TransferCompleted;

      transaction: TransactionWebhookPayload;
    }
  | {
      event: WebhookEventType.TransferFailed;
      transaction: TransactionWebhookPayload;
      statusCode: number;
      error: string;
    }
  | {
      event: WebhookEventType.ReceiptGenerated;
      receiptNumber: number;
      transaction: TransactionWebhookPayload;
    }
);
