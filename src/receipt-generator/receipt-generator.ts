import {
  InjectQueue,
  OnWorkerEvent,
  Processor,
  WorkerHost,
} from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { DLQName, EventType, QueueName } from '../queues/enums';
import { Job, Queue } from 'bullmq';
import { GenerateReceiptJobPayload } from '../outbox/interfaces/job-payload';
import { PrismaService } from '../prisma/prisma.service';
import { ReceiptsService } from '../receipts/receipts.service';
import { generateId } from '../utils/id';
import { EventStatus, Prisma } from '@prisma/client';
import { simulateError } from '../utils/simulation';
import { formatError } from '../utils/formatter';

@Injectable()
@Processor(QueueName.Receipts, {
  concurrency: 4,
})
export class ReceiptGenerator extends WorkerHost {
  constructor(
    private prisma: PrismaService,
    private receiptsService: ReceiptsService,
    @InjectQueue(DLQName.ReceiptsDLQ) private receiptsDLQ: Queue,
  ) {
    super();
  }

  async process(job: Job<GenerateReceiptJobPayload>): Promise<void> {
    const payload = job.data;

    if (!payload.transactionId) return;
    const transaction = await this.prisma.transaction.findUnique({
      where: { id: payload.transactionId },
      include: { ledgerEntries: { orderBy: { amount: 'asc' } } },
    });

    if (!transaction) throw new Error('Transaction not found');

    if (transaction.ledgerEntries.length !== 2)
      throw new Error('Invalid ledger state');

    const [{ accountId: fromAccountId }, { accountId: toAccountId }] =
      transaction.ledgerEntries;

    await this.receiptsService.generateReceipt({
      amount: Math.abs(Number(transaction.ledgerEntries[0].amount)),
      timestamp: new Date(),
      fromAccountId,
      toAccountId,
      receiptNumber: job.data.receiptNumber,
    });

    await this.prisma.$transaction(async (tx) => {
      const { id: receiptId } = await tx.receipt.findUniqueOrThrow({
        where: { number: job.data.receiptNumber },
        select: { id: true },
      });

      await tx.outboxEvent.createMany({
        data: transaction.ledgerEntries.map((entry) => ({
          id: generateId('job'),
          aggregateType: QueueName.Emails,
          aggregateId: `${transaction.id}:${EventType.SendEmails}:${entry.accountId}`,
          eventType: EventType.SendEmails,
          payload: {
            transactionId: transaction.id,
            sendEmailAccountId: entry.accountId,
            receiptId,
          },
        })) as Prisma.OutboxEventCreateManyInput[],
      });
      await tx.$executeRawUnsafe(`NOTIFY outbox_channel`);
    });
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job<GenerateReceiptJobPayload>, error: Error) {
    const payload = job.data;
    if (job.attemptsMade >= job.opts.attempts!) {
      // TODO: add logging + alert
      await this.prisma.receipt.update({
        where: { number: payload.receiptNumber },
        data: {
          status: EventStatus.Failed,
          failedReason: formatError(error),
          failedAt: new Date(),
        },
      });
      await this.receiptsDLQ.add(job.name, job.data, job.opts);
    }
  }
}
