import {
  InjectQueue,
  OnWorkerEvent,
  Processor,
  WorkerHost,
} from '@nestjs/bullmq';
import { Inject, Injectable, type LoggerService } from '@nestjs/common';
import { DLQName, QueueName } from '../queues/enums';
import { Job, Queue, UnrecoverableError } from 'bullmq';
import { SendEmailJobPayload } from '../outbox/interfaces/job-payload';
import { PrismaService } from '../prisma/prisma.service';
import { MailService } from '../mail/mail.service';
import { EventStatus } from '@prisma/client';
import { ReceiptsService } from '../receipts/receipts.service';
import { formatError } from '../utils/formatter';
import {
  propagation,
  ROOT_CONTEXT,
  SpanStatusCode,
  trace,
} from '@opentelemetry/api';
import { WINSTON_MODULE_NEST_PROVIDER } from 'nest-winston';

@Injectable()
@Processor(QueueName.Emails, {
  concurrency: 4,
  limiter: { duration: 60000, max: 100 },
})
export class MailSender extends WorkerHost {
  private readonly TRACE_NAME = 'email-sender';

  constructor(
    private prisma: PrismaService,
    private mailService: MailService,
    private receiptsService: ReceiptsService,
    @InjectQueue(DLQName.EmailsDLQ) private emailDLQ: Queue,
    @Inject(WINSTON_MODULE_NEST_PROVIDER) private logger: LoggerService,
  ) {
    super();
  }

  async process(job: Job<SendEmailJobPayload>): Promise<void> {
    const payload = job.data;
    const jobId = job.id!;

    if (!payload.transactionId) {
      throw new UnrecoverableError('Missing transaction ID');
    }
    const tracer = trace.getTracer(this.TRACE_NAME);
    const parentCtx = propagation.extract(ROOT_CONTEXT, payload._trace ?? {});
    const parentSpanContext = trace.getSpanContext(parentCtx);
    await tracer.startActiveSpan(
      'mail.send',
      { links: parentSpanContext ? [{ context: parentSpanContext }] : [] },
      async (span) => {
        try {
          const transaction = await this.prisma.transaction.findUnique({
            where: { id: payload.transactionId },
            include: { ledgerEntries: { orderBy: { amount: 'asc' } } },
          });

          if (!transaction) throw new Error('Transaction not found');
          if (transaction.ledgerEntries.length !== 2)
            throw new Error('Invalid ledger state');

          const [{ accountId: fromAccountId }, { accountId: toAccountId }] =
            transaction.ledgerEntries;

          let sentAt: Date | null = null;
          /**
           * STEP 1 — Atomically claim the job
           */
          const event = await this.prisma.emailEvent.upsert({
            where: { id: jobId },
            create: {
              id: jobId,
              payload: payload as any,
              toAccountId: payload.sendEmailAccountId,
              status: EventStatus.Processing,
            },
            update: {},
          });
          if (event.status === EventStatus.Done && event.sentAt) {
            return;
          }

          sentAt = event.sentAt;

          /**
           * STEP 2 — Perform side effect
           */
          const account = await this.prisma.account.findUnique({
            where: { id: payload.sendEmailAccountId },
            select: { email: true },
          });

          if (!account) {
            throw new UnrecoverableError('Cannot find account to send email');
          }
          span.setAttribute('mail.to', account.email);

          if (!sentAt) {
            sentAt = new Date();
            await this.prisma.emailEvent.update({
              where: { id: jobId },
              data: { sentAt },
            });
          }

          const { object, objectName, mimetype } =
            await this.receiptsService.getReceiptFile(payload.receiptId);

          this.logger.log('mail.sending', {
            component: 'mail',
            jobId: job.id,
            attempts: job.attemptsMade,
          });

          await this.mailService.sendConfirmTransferEmail(
            account.email,
            {
              amount: Math.abs(Number(transaction.ledgerEntries[0].amount)),
              timestamp: sentAt,
              fromAccountId,
              toAccountId,
              transactionId: transaction.id,
            },
            {
              contentDisposition: 'inline',
              content: object,
              filename: objectName,
              contentType: mimetype,
              encoding: 'utf-8',
            },
          );

          /**
           * STEP 3 — Mark delivered
           */
          await this.prisma.emailEvent.update({
            where: { id: jobId },
            data: { status: EventStatus.Done },
          });
          this.logger.log('mail.send.success', {
            component: 'mail',
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
      },
    );
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job<SendEmailJobPayload>, error: Error) {
    const payload = job.data;
    const tracer = trace.getTracer(this.TRACE_NAME);
    const parentCtx = propagation.extract(ROOT_CONTEXT, payload._trace ?? {});
    const parentSpanContext = trace.getSpanContext(parentCtx);
    if (
      job.attemptsMade === job.opts.attempts! ||
      error instanceof UnrecoverableError
    ) {
      await tracer.startActiveSpan(
        'mail.dlq',
        { links: parentSpanContext ? [{ context: parentSpanContext }] : [] },
        async (span) => {
          try {
            await this.prisma.emailEvent.updateMany({
              where: { id: job.id! },
              data: {
                status: EventStatus.Failed,
                failedAt: new Date(),
                error: formatError(error),
              },
            });
            await this.emailDLQ.add(job.name, job.data, job.opts);
            this.logger.error('mail.dlq.success', {
              component: 'mail',
              jobId: job.id,
              attempts: job.attemptsMade,
              error: error.stack,
            });
          } catch (error) {
            span.recordException(error);
            span.setStatus({ code: SpanStatusCode.ERROR });
            this.logger.error('mail.dlq.failed', {
              component: 'mail',
              jobId: job.id,
              attempts: job.attemptsMade,
              error: error.stack,
            });
            throw error;
          } finally {
            span.end();
          }
        },
      );
    } else {
      await tracer.startActiveSpan(
        'mail.retry',
        { links: parentSpanContext ? [{ context: parentSpanContext }] : [] },
        async (span) => {
          try {
            this.logger.warn('mail.retry.scheduled', {
              component: 'mail',
              jobId: job.id,
              attempts: job.attemptsMade,
              error: error.stack,
            });
          } finally {
            span.end();
          }
        },
      );
    }
  }
}
