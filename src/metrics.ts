// src/observability/metrics.ts

import { metrics } from '@opentelemetry/api';

export const meter = metrics.getMeter('banking-system');

/**
 * ---------------------------------------------------
 * TRANSFER METRICS
 * ---------------------------------------------------
 */

export const transferRequestsTotal = meter.createCounter(
  'transfer_requests_total',
  {
    description: 'Total number of transfer requests',
  },
);

export const transferFailuresTotal = meter.createCounter(
  'transfer_failures_total',
  {
    description: 'Total failed transfers',
  },
);

export const transferDurationSeconds = meter.createHistogram(
  'transfer_duration_seconds',
  {
    description: 'Transfer API duration in seconds',
    unit: 's',
  },
);

export const duplicateTransferPreventedTotal = meter.createCounter(
  'duplicate_transfer_prevented_total',
  {
    description: 'Duplicate transfers prevented',
  },
);

/**
 * ---------------------------------------------------
 * LEDGER METRICS
 * ---------------------------------------------------
 */

export const ledgerEntriesCreatedTotal = meter.createCounter(
  'ledger_entries_created_total',
  {
    description: 'Total ledger entries created',
  },
);

/**
 * ---------------------------------------------------
 * DATABASE METRICS
 * ---------------------------------------------------
 */

export const dbTransactionDurationSeconds = meter.createHistogram(
  'db_transaction_duration_seconds',
  {
    description: 'Database transaction duration',
    unit: 's',
  },
);

export const ledgerQueryDurationSeconds = meter.createHistogram(
  'ledger_query_duration_seconds',
  {
    description: 'Ledger query duration',
    unit: 's',
  },
);

export const activeDbTransactions = meter.createUpDownCounter(
  'active_db_transactions',
  {
    description: 'Current active DB transactions',
  },
);

/**
 * ---------------------------------------------------
 * OUTBOX METRICS
 * ---------------------------------------------------
 */

export const outboxEventsCreatedTotal = meter.createCounter(
  'outbox_events_created_total',
  {
    description: 'Total outbox events created',
  },
);

export const outboxEventsProcessedTotal = meter.createCounter(
  'outbox_events_processed_total',
  {
    description: 'Total processed outbox events',
  },
);

export const outboxEnqueueFailuresTotal = meter.createCounter(
  'outbox_enqueue_failures_total',
  {
    description: 'Total outbox enqueue failures',
  },
);

export const outboxProcessingDelaySeconds = meter.createHistogram(
  'outbox_processing_delay_seconds',
  {
    description: 'Delay between outbox creation and enqueue',
    unit: 's',
  },
);

/**
 * ---------------------------------------------------
 * BULLMQ / QUEUE METRICS
 * ---------------------------------------------------
 */

export const jobsAddedTotal = meter.createCounter('jobs_added_total', {
  description: 'Total jobs added to queues',
});

export const jobsProcessedTotal = meter.createCounter('jobs_processed_total', {
  description: 'Total processed jobs',
});

export const jobsFailedTotal = meter.createCounter('jobs_failed_total', {
  description: 'Total failed jobs',
});

export const jobsDlqTotal = meter.createCounter('jobs_dlq_total', {
  description: 'Total jobs moved to DLQ',
});

export const jobsRetriedTotal = meter.createCounter('jobs_retried_total', {
  description: 'Total jobs retried',
});

export const duplicatedJobsPreventedTotal = meter.createCounter(
  'duplicated_jobs_prevented_total',
  {
    description: 'Total duplicate jobs prevented',
  },
);

export const jobProcessingDurationSeconds = meter.createHistogram(
  'job_processing_duration_seconds',
  {
    description: 'Job processing duration',
    unit: 's',
  },
);

export const jobWaitDurationSeconds = meter.createHistogram(
  'job_wait_duration_seconds',
  {
    description: 'Time spent waiting in queue before processing',
    unit: 's',
  },
);

/**
 * ---------------------------------------------------
 * WEBHOOK METRICS
 * ---------------------------------------------------
 */

export const webhookDeliveryTotal = meter.createCounter(
  'webhook_delivery_total',
  {
    description: 'Total webhook delivery attempts',
  },
);

/**
 * ---------------------------------------------------
 * RETRY / DLQ METRICS
 * ---------------------------------------------------
 */

export const poisonJobsTotal = meter.createCounter('poison_jobs_total', {
  description: 'Total poison jobs detected',
});

/**
 * ---------------------------------------------------
 * SECURITY / RATE LIMIT METRICS
 * ---------------------------------------------------
 */

export const rateLimitHitsTotal = meter.createCounter('rate_limit_hits_total', {
  description: 'Total rate limit hits',
});

export const authFailuresTotal = meter.createCounter('auth_failures_total', {
  description: 'Total authentication failures',
});

/**
 * ---------------------------------------------------
 * BUSINESS METRICS
 * ---------------------------------------------------
 */

export const moneyTransferredTotal = meter.createCounter(
  'money_transferred_total',
  {
    description: 'Total amount of money transferred',
  },
);

export const completedTransfersTotal = meter.createCounter(
  'completed_transfers_total',
  {
    description: 'Total completed transfers',
  },
);

// same as money_transferred_total but as a histogram to track distribution of transfer amounts, useful for detecting anomalies like unusually large transfers
export const transferAmountHistogram = meter.createHistogram(
  'transfer_amount',
  {
    description: 'Distribution of transfer amounts',
  },
);

/**
 * ---------------------------------------------------
 * END-TO-END SYSTEM METRICS
 * ---------------------------------------------------
 */

export const transferEndToEndDurationSeconds = meter.createHistogram(
  'transfer_end_to_end_duration_seconds',
  {
    description:
      'Total duration from API request until all async workflows complete',
    unit: 's',
  },
);
