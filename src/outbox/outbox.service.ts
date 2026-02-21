import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { OutboxEventStatus } from '@prisma/client';
import { EventType, QueueName } from '../queues/enums';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { sleep } from '../utils/timer';
import { OUTBOX_MAX_ATTEMPTS } from '../constants';

@Injectable()
export class OutboxService {
  constructor(
    private prisma: PrismaService,
    @InjectQueue(QueueName.Webhooks) private webhooksQueue: Queue,
    @InjectQueue(QueueName.Analytics) private analyticsQueue: Queue,
    @InjectQueue(QueueName.Emails) private emailsQueue: Queue,
    @InjectQueue(QueueName.Receipts) private receiptsQueue: Queue,
  ) {}

  async pollOutbox() {
    const toEnqueueJobs = await this.prisma.$transaction(async (tx) => {
      const pendingJobs = await tx.$queryRaw<
        {
          id: string;
          event_type: EventType;
          attempt_count: number;
          payload: object;
        }[]
      >`
        UPDATE outbox_events
        SET status = 'Processing',
            attempt_count = attempt_count + 1,
            next_retry_at = now() + (interval '1 second' * LEAST(5 * POWER(2, attempt_count - 1) + 5 * POWER(2, attempt_count - 1) * 0.5 * RANDOM(), 600))

        WHERE id IN (
          SELECT id FROM outbox_events
          WHERE status = 'Pending'
            OR (status = 'Processing' AND next_retry_at <= now())
          ORDER BY created_at
          FOR UPDATE SKIP LOCKED
          LIMIT 50
        )
        RETURNING id, event_type, payload, attempt_count;
    `;

      return pendingJobs;
    });

    if (toEnqueueJobs.length === 0) return;
    const enqueues = toEnqueueJobs.map(async (job) => {
      console.log('Enqueueing job:', job);
      try {
        switch (job.event_type) {
          case EventType.SendWebhooks:
            await this.webhooksQueue.add(job.event_type, job.payload);
            break;
          case EventType.TrackAnalytics:
            await this.analyticsQueue.add(job.event_type, job.payload);
            break;
          case EventType.SendEmails:
            await this.emailsQueue.add(job.event_type, job.payload);
            break;
          case EventType.GenerateReceipts:
            await this.receiptsQueue.add(job.event_type, job.payload);
            break;
          default:
            console.warn('Skipped due to unknown event type', job.event_type);
            break;
        }
      } catch (error) {
        throw error;
      }
    });

    const results = await Promise.allSettled(enqueues);
    const successIds = toEnqueueJobs
      .filter((_, i) => results[i].status === 'fulfilled')
      .map((job) => job.id);
    const failedIds = toEnqueueJobs
      .filter(
        (job, i) =>
          job.attempt_count + 1 >= OUTBOX_MAX_ATTEMPTS &&
          results[i].status === 'rejected',
      )
      .map((job) => job.id);

    await this.prisma.outboxEvent.updateMany({
      where: { id: { in: successIds } },
      data: {
        processedAt: new Date(),
        status: OutboxEventStatus.Delivered,
      },
    });

    await this.prisma.outboxEvent.updateMany({
      where: { id: { in: failedIds } },
      data: {
        status: OutboxEventStatus.Failed,
      },
    });
  }
}
