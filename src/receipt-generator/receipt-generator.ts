import {
  InjectQueue,
  OnWorkerEvent,
  Processor,
  WorkerHost,
} from '@nestjs/bullmq';
import { Inject, Injectable, type LoggerService } from '@nestjs/common';
import { DLQName, EventType, QueueName } from '../queues/enums';
import { Job, Queue, UnrecoverableError } from 'bullmq';
import { GenerateReceiptJobPayload } from '../outbox/interfaces/job-payload';
import { PrismaService } from '../prisma/prisma.service';
import { ReceiptsService } from '../receipts/receipts.service';
import { generateId } from '../utils/id';
import { EventStatus, Prisma } from '@prisma/client';
import { formatError } from '../utils/formatter';
import { WebhooksService } from '../webhooks/webhooks.service';
import { WebhookEventType } from '../webhooks/enums';
import {
  context,
  propagation,
  ROOT_CONTEXT,
  SpanStatusCode,
  trace,
} from '@opentelemetry/api';
import { WINSTON_MODULE_NEST_PROVIDER } from 'nest-winston';

@Injectable()
@Processor(QueueName.Receipts, {
  concurrency: 4,
})
export class ReceiptGenerator extends WorkerHost {
  private readonly TRACE_NAME = 'receipt-generator';

  constructor(
    private prisma: PrismaService,
    private receiptsService: ReceiptsService,
    private webhooksService: WebhooksService,
    @InjectQueue(DLQName.ReceiptsDLQ) private receiptsDLQ: Queue,
    @Inject(WINSTON_MODULE_NEST_PROVIDER) private logger: LoggerService,
  ) {
    super();
  }

  async process(job: Job<GenerateReceiptJobPayload>): Promise<void> {
    const payload = job.data;

    if (!payload.transactionId) return;
    const tracer = trace.getTracer(this.TRACE_NAME);
    const parentCtx = propagation.extract(ROOT_CONTEXT, payload._trace ?? {});
    const parentSpanContext = trace.getSpanContext(parentCtx);
    await tracer.startActiveSpan(
      'receipt.generate',
      {
        links: parentSpanContext ? [{ context: parentSpanContext }] : [],
      },
      async (span) => {
        try {
          const transaction = await this.prisma.transaction.findUnique({
            where: { id: payload.transactionId },
            include: { ledgerEntries: { orderBy: { amount: 'asc' } } },
          });
          span.setAttribute('receipt.number', payload.receiptNumber);
          span.setAttribute('receipt.attempts_made', job.attemptsMade);

          if (!transaction) throw new Error('Transaction not found');

          if (transaction.ledgerEntries.length !== 2)
            throw new Error('Invalid ledger state');

          const [{ accountId: fromAccountId }, { accountId: toAccountId }] =
            transaction.ledgerEntries;

          const amount = Math.abs(Number(transaction.ledgerEntries[0].amount));
          await tracer.startActiveSpan('pdf.generate', async (span) => {
            try {
              this.logger.log('receipt.generating', {
                component: 'receipt',
                jobId: job.id,
                attempts: job.attemptsMade,
              });
              await this.receiptsService.generateReceipt({
                amount,
                timestamp: new Date(),
                fromAccountId,
                toAccountId,
                receiptNumber: job.data.receiptNumber,
              });
              this.logger.log('receipt.pdf.generated', {
                component: 'receipt',
                jobId: job.id,
                attempts: job.attemptsMade,
              });
            } catch (error) {
              span.recordException(error);
              span.setStatus({ code: SpanStatusCode.ERROR });
              throw error;
            } finally {
              span.end();
            }
          });

          await tracer.startActiveSpan('outbox.email.create', async (span) => {
            try {
              await this.prisma.$transaction(async (tx) => {
                const { id: receiptId } = await tx.receipt.findUniqueOrThrow({
                  where: { number: job.data.receiptNumber },
                  select: { id: true },
                });

                const fromEndpoints =
                  await this.webhooksService.findRegisteredEndpointIds(
                    WebhookEventType.ReceiptGenerated,
                    fromAccountId,
                    tx,
                  );

                const toEndpoints =
                  await this.webhooksService.findRegisteredEndpointIds(
                    WebhookEventType.ReceiptGenerated,
                    toAccountId,
                    tx,
                  );

                await tx.outboxEvent.createMany({
                  data: [
                    ...(transaction.ledgerEntries.map((entry) => ({
                      id: generateId('obx'),
                      aggregateType: 'Transaction',
                      aggregateId: `${transaction.id}:${entry.accountId}`,
                      eventType: EventType.SendEmails,
                      traceContext: payload._trace ?? {},
                      payload: {
                        transactionId: transaction.id,
                        sendEmailAccountId: entry.accountId,
                        receiptId,
                      },
                    })) as Prisma.OutboxEventCreateManyInput[]),
                    ...[...fromEndpoints, ...toEndpoints].map((endpoint) => ({
                      id: generateId('obx'),
                      aggregateType: 'Transaction',
                      aggregateId: `${transaction.id}:${endpoint}`,
                      eventType: WebhookEventType.ReceiptGenerated,
                      traceContext: payload._trace ?? {},
                      payload: {
                        endpointId: endpoint,
                        event: WebhookEventType.ReceiptGenerated,
                        eventId: generateId('evt'),
                        receiptNumber: job.data.receiptNumber,
                        transaction: {
                          id: transaction.id,
                          amount,
                          currency: 'USD',
                          occurredAt: transaction.createdAt.toISOString(),
                          fromAccountId,
                          toAccountId,
                        },
                      },
                    })),
                  ],
                });
                await tx.$executeRawUnsafe(`NOTIFY outbox_channel`);
              });
              this.logger.log('outbox.email.created', {
                component: 'receipt',
                jobId: job.id,
                attempts: job.attemptsMade,
              });
            } catch (error) {
              span.recordException(error);
              span.setStatus({ code: SpanStatusCode.ERROR });
              throw error;
            } finally {
              span.end();
            }
          });
        } catch (error) {
          span.recordException(error);
          span.setStatus({ code: SpanStatusCode.ERROR });
          throw error;
        } finally {
          span.end();
        }
      },
    );
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job<GenerateReceiptJobPayload>, error: Error) {
    const payload = job.data;
    const tracer = trace.getTracer(this.TRACE_NAME);
    const ctx = propagation.extract(ROOT_CONTEXT, payload._trace);

    if (
      job.attemptsMade === job.opts.attempts! ||
      error instanceof UnrecoverableError
    ) {
      await context.with(ctx, async () => {
        await tracer.startActiveSpan('receipt.dlq', async (span) => {
          try {
            await this.prisma.receipt.update({
              where: { number: payload.receiptNumber },
              data: {
                status: EventStatus.Failed,
                error: formatError(error),
                failedAt: new Date(),
              },
            });
            await this.receiptsDLQ.add(job.name, job.data, job.opts);
            this.logger.error('receipt.dlq.success', {
              component: 'receipt',
              id: job.id,
              attempts: job.attemptsMade,
              error: error.stack,
            });
          } catch (error) {
            span.recordException(error);
            span.setStatus({ code: SpanStatusCode.ERROR });
            this.logger.error('receipt.dlq.failed', {
              component: 'receipt',
              id: job.id,
              attempts: job.attemptsMade,
              error: error.stack,
            });
          } finally {
            span.end();
          }
        });
      });
    } else {
      this.logger.warn('receipt.retry.scheduled', {
        component: 'receipt',
        id: job.id,
        attempts: job.attemptsMade,
        error: error.stack,
      });
    }
  }
}
