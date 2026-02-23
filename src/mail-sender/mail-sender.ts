import {
  InjectQueue,
  OnWorkerEvent,
  Processor,
  WorkerHost,
} from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { DLQName, QueueName } from '../queues/enums';
import { Job, Queue, UnrecoverableError } from 'bullmq';
import { SendEmailJobPayload } from '../outbox/interfaces/job-payload';
import { PrismaService } from '../prisma/prisma.service';
import { MailService } from '../mail/mail.service';
import { simulateError } from '../utils/simulation';
import { EventStatus } from '@prisma/client';
import { ReceiptsService } from '../receipts/receipts.service';
import { formatError } from '../utils/formatter';

@Injectable()
@Processor(QueueName.Emails, {
  concurrency: 4,
  limiter: { duration: 60000, max: 100 },
})
export class MailSender extends WorkerHost {
  constructor(
    private prisma: PrismaService,
    private mailService: MailService,
    private receiptsService: ReceiptsService,
    @InjectQueue(DLQName.EmailsDLQ) private emailDLQ: Queue,
  ) {
    super();
  }

  async process(job: Job<SendEmailJobPayload>): Promise<void> {
    const payload = job.data;
    const jobId = job.id!;

    console.log(
      `Job ${job.id} is being processed: attempts made=${job.attemptsMade}/${job.opts.attempts}`,
    );

    if (!payload.transactionId) {
      throw new UnrecoverableError('Missing transaction ID');
    }

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

    if (!sentAt) {
      sentAt = new Date();
      await this.prisma.emailEvent.update({
        where: { id: jobId },
        data: { sentAt },
      });
    }

    const { object, objectName, mimetype } =
      await this.receiptsService.getReceiptFile(payload.receiptId);

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
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job<SendEmailJobPayload>, error: Error) {
    console.log(
      `Job ${job.id} failed, attempts made=${job.attemptsMade}/${job.opts.attempts}. Retry after ${job.delay}ms`,
    );
    console.error(`Reason: ${error}`);
    if (job.attemptsMade >= job.opts.attempts!) {
      await this.prisma.emailEvent.updateMany({
        where: { id: job.id! },
        data: {
          status: EventStatus.Failed,
          failedAt: new Date(),
          failedReason: formatError(error),
        },
      });
      await this.emailDLQ.add(job.name, job.data, job.opts);
    } else {
      await this.prisma.emailEvent.updateMany({
        where: { id: job.id! },
        data: {
          attemptCount: job.attemptsMade,
        },
      });
    }
  }
}
