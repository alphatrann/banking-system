import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { metrics } from '@opentelemetry/api';
import { DLQName, QueueName } from '../queues/enums';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class MetricsService {
  private meter = metrics.getMeter('banking-system');

  constructor(
    @InjectQueue(QueueName.Emails) private readonly emailQueue: Queue,
    @InjectQueue(QueueName.Webhooks) private readonly webhookQueue: Queue,
    @InjectQueue(QueueName.Receipts) private readonly receiptQueue: Queue,
    @InjectQueue(DLQName.EmailsDLQ) private readonly emailsDLQ: Queue,
    @InjectQueue(DLQName.WebhooksDLQ) private readonly webhooksDLQ: Queue,
    @InjectQueue(DLQName.ReceiptsDLQ) private readonly receiptsDLQ: Queue,
    private readonly prisma: PrismaService,
  ) {
    this.registerGauges();
  }

  private registerGauges() {
    const pendingOutboxEvents = this.meter.createObservableGauge(
      'outbox_pending_events',
      {
        description: 'Current pending outbox events',
      },
    );

    pendingOutboxEvents.addCallback(async (observableResult) => {
      const count = await this.prisma.outboxEvent.count({
        where: { processedAt: null },
      });
      observableResult.observe(count);
    });

    const queueSize = this.meter.createObservableGauge('queue_size', {
      description: 'Current size of BullMQ queues',
    });

    queueSize.addCallback(async (observableResult) => {
      const [emailQueueCount, webhookQueueCount, receiptQueueCount] =
        await Promise.all([
          this.emailQueue.getWaitingCount(),
          this.webhookQueue.getWaitingCount(),
          this.receiptQueue.getWaitingCount(),
        ]);

      observableResult.observe(emailQueueCount, { queue: QueueName.Emails });
      observableResult.observe(webhookQueueCount, {
        queue: QueueName.Webhooks,
      });
      observableResult.observe(receiptQueueCount, {
        queue: QueueName.Receipts,
      });
    });

    const dlqSize = this.meter.createObservableGauge('dlq_size', {
      description: 'Current size of BullMQ Dead Letter Queues',
    });

    dlqSize.addCallback(async (observableResult) => {
      const [emailsDLQCount, webhooksDLQCount, receiptsDLQCount] =
        await Promise.all([
          this.emailsDLQ.getWaitingCount(),
          this.webhooksDLQ.getWaitingCount(),
          this.receiptsDLQ.getWaitingCount(),
        ]);
      observableResult.observe(emailsDLQCount, { queue: DLQName.EmailsDLQ });
      observableResult.observe(webhooksDLQCount, {
        queue: DLQName.WebhooksDLQ,
      });
      observableResult.observe(receiptsDLQCount, {
        queue: DLQName.ReceiptsDLQ,
      });
    });

    const delayedJobs = this.meter.createObservableGauge('delayed_jobs', {
      description: 'Current number of delayed jobs in BullMQ queues',
    });
    delayedJobs.addCallback(async (observableResult) => {
      const [emailDelayedCount, webhookDelayedCount, receiptDelayedCount] =
        await Promise.all([
          this.emailQueue.getDelayedCount(),
          this.webhookQueue.getDelayedCount(),
          this.receiptQueue.getDelayedCount(),
        ]);
      observableResult.observe(emailDelayedCount, { queue: QueueName.Emails });
      observableResult.observe(webhookDelayedCount, {
        queue: QueueName.Webhooks,
      });
      observableResult.observe(receiptDelayedCount, {
        queue: QueueName.Receipts,
      });
    });

    const activeJobs = this.meter.createObservableGauge('active_jobs', {
      description: 'Current number of active jobs in BullMQ queues',
    });

    activeJobs.addCallback(async (observableResult) => {
      const [emailActiveCount, webhookActiveCount, receiptActiveCount] =
        await Promise.all([
          this.emailQueue.getActiveCount(),
          this.webhookQueue.getActiveCount(),
          this.receiptQueue.getActiveCount(),
        ]);
      observableResult.observe(emailActiveCount, { queue: QueueName.Emails });
      observableResult.observe(webhookActiveCount, {
        queue: QueueName.Webhooks,
      });
      observableResult.observe(receiptActiveCount, {
        queue: QueueName.Receipts,
      });
    });
  }
}
