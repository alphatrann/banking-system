import { WebhookEventType } from '../../webhooks/enums';

export interface JobPayload {
  _trace: Record<string, string> | null;
}

export interface GenerateReceiptJobPayload extends JobPayload {
  transactionId: string;
  receiptNumber: number;
}

export interface SendEmailJobPayload extends JobPayload {
  transactionId: string;
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

export type SendWebhookJobPayload = JobPayload & {
  endpointId: string;
  eventId: string;
} & (
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
