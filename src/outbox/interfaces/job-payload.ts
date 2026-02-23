import { WebhookEventType } from '../../webhooks/enums';

export interface JobPayload {
  transactionId?: string;
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
  amount: number;
  toAccountId: string;
  fromAccountId: string;
  currency: 'USD';
  occurredAt: string;
}
export interface CompletedTransactionWebhookPayload extends TransactionWebhookPayload {
  id: string;
}
export interface FailedTransactionWebhookPayload extends TransactionWebhookPayload {}

export type SendWebhookJobPayload = { endpointId: string; eventId: string } & (
  | {
      event: WebhookEventType.TransferCompleted;

      transaction: CompletedTransactionWebhookPayload;
    }
  | {
      event: WebhookEventType.TransferFailed;
      transaction: FailedTransactionWebhookPayload;
      statusCode: number;
      error: string;
    }
  | {
      event: WebhookEventType.ReceiptGenerated;
      receiptNumber: number;
      transaction: CompletedTransactionWebhookPayload;
    }
);
