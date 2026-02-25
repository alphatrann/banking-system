import { Inject, Injectable, type LoggerService } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { OutboxEventStatus } from '@prisma/client';
import { EventType, QueueName } from '../queues/enums';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { OUTBOX_MAX_ATTEMPTS } from '../constants';
import { WebhookEventType } from '../webhooks/enums';
import {
  propagation,
  ROOT_CONTEXT,
  SpanStatusCode,
  trace,
} from '@opentelemetry/api';
import { WINSTON_MODULE_NEST_PROVIDER } from 'nest-winston';

@Injectable()
export class OutboxService {
  private readonly TRACING_NAME = 'outbox';

  constructor(
    private prisma: PrismaService,
    @Inject(WINSTON_MODULE_NEST_PROVIDER)
    private readonly logger: LoggerService,
    @InjectQueue(QueueName.Webhooks) private webhooksQueue: Queue,
    @InjectQueue(QueueName.Emails) private emailsQueue: Queue,
    @InjectQueue(QueueName.Receipts) private receiptsQueue: Queue,
  ) {}

  async pollOutbox() {
    const toEnqueueJobs = await this.prisma.$transaction(async (tx) => {
      const pendingJobs = await tx.$queryRaw<
        {
          id: string;
          event_type: EventType | WebhookEventType;
          attempt_count: number;
          payload: object;
          trace_context: Record<string, string>;
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
        RETURNING id, event_type, payload, attempt_count, trace_context;
    `;

      return pendingJobs;
    });

    if (toEnqueueJobs.length === 0) return;
    const enqueues = toEnqueueJobs.map(async (job) => {
      const tracer = trace.getTracer(this.TRACING_NAME);
      const parentCtx = propagation.extract(ROOT_CONTEXT, job.trace_context);
      const parentSpanContext = trace.getSpanContext(parentCtx);
      const startMs = Date.now();
      await tracer.startActiveSpan(
        'outbox.process',
        { links: parentSpanContext ? [{ context: parentSpanContext }] : [] },
        async (span) => {
          this.logger.log({
            event: 'outbox.dispatch',
            component: 'outbox',
            jobId: job.id,
            attempts: job.attempt_count,
            durationMs: Date.now() - startMs,
          });
          const payload = { ...job.payload, _trace: job.trace_context };
          this.logger.debug?.({
            event: 'outbox.payload.prepare',
            component: 'outbox',
            jobId: job.id,
            eventType: job.event_type,
            attempts: job.attempt_count,
            payload: job.payload,
          });
          try {
            switch (job.event_type) {
              case WebhookEventType.TransferCompleted:
              case WebhookEventType.TransferFailed:
              case WebhookEventType.ReceiptGenerated:
                await this.webhooksQueue.add(job.event_type, payload, {
                  jobId: job.id,
                });
                break;
              case EventType.SendEmails:
                await this.emailsQueue.add(job.event_type, payload, {
                  jobId: job.id,
                });
                break;
              case EventType.GenerateReceipts:
                await this.receiptsQueue.add(job.event_type, payload, {
                  jobId: job.id,
                });
                break;
              default:
                console.warn(
                  'Skipped due to unknown event type',
                  job.event_type,
                );
                break;
            }
            span.setStatus({ code: SpanStatusCode.OK });
            this.logger.log({
              message: 'outbox.enqueue.success',
              component: 'outbox',
              jobId: job.id,
              attempts: job.attempt_count,
              durationMs: Date.now() - startMs,
            });
          } catch (error) {
            span.recordException(error);
            span.setStatus({ code: SpanStatusCode.ERROR });
            if (job.attempt_count + 1 >= OUTBOX_MAX_ATTEMPTS) {
              this.logger.error({
                message: `outbox.enqueue.failed`,
                component: 'outbox',
                jobId: job.id,
                attempts: job.attempt_count,
                traceId: span.spanContext().traceId,
                durationMs: Date.now() - startMs,
                error: error.stack,
              });
            } else {
              this.logger.warn({
                message: `outbox.retry.scheduled`,
                component: 'outbox',
                jobId: job.id,
                attempts: job.attempt_count,
                durationMs: Date.now() - startMs,
                error: error.stack,
              });
            }
            throw error;
          } finally {
            span.end();
          }
        },
      );
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
