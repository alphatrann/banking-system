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

export interface SendWebhookJobPayload extends JobPayload {
  webhookEndpointId: string;
  event: WebhookEventType;
}
