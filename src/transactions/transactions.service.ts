import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateTransactionDto } from './dto/create-transaction.dto';
import { generateId } from '../utils/id';
import { hash } from '../utils/hash';
import { Prisma } from '@prisma/client';
import {
  isForeignKeyViolation,
  isSerializationFailure,
  isUniqueViolation,
} from '../prisma/error-codes';
import { BASE_ACCOUNT_AMOUNT } from '../constants';
import { EventType, QueueName } from '../queues/enums';

@Injectable()
export class TransactionsService {
  private readonly MAX_SERIALIZATION_RETRIES = 3;

  constructor(private readonly prisma: PrismaService) {}

  async transferMoney(
    dto: CreateTransactionDto,
    idempotencyKey: string,
    fromAccountId: string,
  ) {
    const requestHash = this.hashRequest(idempotencyKey, dto);

    let responseBody: any;

    // 2️⃣ Run financial logic with SERIALIZABLE retry
    for (
      let attempt = 1;
      attempt <= this.MAX_SERIALIZATION_RETRIES;
      attempt++
    ) {
      try {
        await this.prisma.$transaction(
          async (tx) => {
            await tx.idempotencyKey.create({
              data: {
                accountId: fromAccountId,
                key: idempotencyKey,
                requestHash,
              },
            });
            const transaction = await this.handleTransaction(
              fromAccountId,
              tx,
              dto,
            );

            await this.insertOutbox(transaction, dto, fromAccountId, tx);

            responseBody = {
              statusCode: HttpStatus.CREATED,
              transaction: {
                id: transaction.id,
                amount: dto.amount,
                createdAt: transaction.createdAt.toISOString(),
              },
            };
            await this.updateIdempotencyKey(
              fromAccountId,
              idempotencyKey,
              responseBody,
              tx,
            );
          },
          {
            isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
          },
        );

        break;
      } catch (error: any) {
        if (isUniqueViolation(error)) {
          const existing = await this.prisma.idempotencyKey.findUnique({
            where: {
              accountId_key: { accountId: fromAccountId, key: idempotencyKey },
            },
          });

          if (existing) {
            if (existing.requestHash !== requestHash) {
              throw new BadRequestException({
                statusCode: HttpStatus.BAD_REQUEST,
                error: 'Idempotency key reused with different payload',
                transaction: null,
              });
            }

            if (existing.responseCode && existing.responseBody) {
              if (existing.responseCode !== HttpStatus.CREATED)
                throw new HttpException(
                  existing.responseBody as object,
                  existing.responseCode,
                );

              return existing.responseBody;
            }
          }

          throw new ConflictException({
            statusCode: HttpStatus.CONFLICT,
            error: 'Request is still processing',
          });
        }

        if (
          isSerializationFailure(error) &&
          attempt < this.MAX_SERIALIZATION_RETRIES
        ) {
          continue;
        }

        if (error instanceof BadRequestException) {
          responseBody = error.getResponse() as any;
          break;
        }

        if (isForeignKeyViolation(error)) {
          responseBody = {
            statusCode: HttpStatus.NOT_FOUND,
            error: "Destination account doesn't exist.",
          };
          break;
        }

        responseBody = {
          statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
          error: 'Internal error while processing transaction',
        };
        break;
      }
    }

    if (responseBody.statusCode !== HttpStatus.CREATED) {
      await this.updateIdempotencyKey(
        fromAccountId,
        idempotencyKey,
        responseBody,
      );
      throw new HttpException(responseBody, responseBody.statusCode);
    }

    return responseBody;
  }

  private async updateIdempotencyKey(
    fromAccountId: string,
    idempotencyKey: string,
    responseBody: any,
    tx?: Prisma.TransactionClient,
  ) {
    await (tx ?? this.prisma).idempotencyKey.update({
      where: {
        accountId_key: {
          accountId: fromAccountId,
          key: idempotencyKey,
        },
      },
      data: {
        responseBody,
        responseCode: responseBody.statusCode,
      },
    });
  }

  private async insertOutbox(
    transaction: { id: string; createdAt: Date },
    dto: CreateTransactionDto,
    fromAccountId: string,
    tx: Prisma.TransactionClient,
  ) {
    const receiptGeneratorId = generateId('rec');
    const analyticsTrackerId = generateId('anl');
    const webhookSenderId = generateId('whk');
    const webhookReceiverId = generateId('whk');
    const jobs: Prisma.OutboxEventCreateManyInput[] = [
      {
        id: receiptGeneratorId,
        aggregateId: `${transaction.id}:${EventType.GenerateReceipts}`,
        aggregateType: QueueName.Receipts,
        eventType: EventType.GenerateReceipts,
        payload: {
          transactionId: transaction.id,
          amount: dto.amount,
          fromAccountId,
          toAccountId: dto.toAccountId,
          createdAt: transaction.createdAt.toISOString(),
        },
      },
      {
        id: analyticsTrackerId,
        aggregateId: `${transaction.id}:${EventType.TrackAnalytics}`,
        aggregateType: QueueName.Analytics,
        eventType: EventType.TrackAnalytics,
        payload: { transactionId: transaction.id },
      },
      {
        id: webhookSenderId,
        aggregateId: `${transaction.id}:${EventType.SendWebhooks}:${fromAccountId}`,
        aggregateType: QueueName.Webhooks,
        eventType: EventType.SendWebhooks,
        payload: { transactionId: transaction.id, fromAccountId },
      },
      {
        id: webhookReceiverId,
        aggregateId: `${transaction.id}:${EventType.SendWebhooks}:${dto.toAccountId}`,
        aggregateType: QueueName.Webhooks,
        eventType: EventType.SendWebhooks,
        payload: {
          transactionId: transaction.id,
          toAccountId: dto.toAccountId,
        },
      },
    ];

    await tx.outboxEvent.createMany({ data: jobs });
    await tx.$executeRawUnsafe(`
      NOTIFY outbox_channel
    `);
  }

  private async handleTransaction(
    fromAccountId: string,
    tx: Prisma.TransactionClient,
    dto: CreateTransactionDto,
  ) {
    const fromBalance = await this.computeBalance(fromAccountId, tx);

    if (dto.amount > fromBalance) {
      throw new BadRequestException({
        statusCode: HttpStatus.BAD_REQUEST,
        error: 'Insufficient balance',
      });
    }

    const transactionId = generateId('trans');

    const toBalance = await this.computeBalance(dto.toAccountId, tx);

    const transaction = await tx.transaction.create({
      data: {
        id: transactionId,
        ledgerEntries: {
          createMany: {
            data: [
              {
                accountId: fromAccountId,
                amount: -dto.amount,
                runningBalance: fromBalance - dto.amount,
              },
              {
                accountId: dto.toAccountId,
                amount: dto.amount,
                runningBalance: toBalance + dto.amount,
              },
            ],
          },
        },
      },
    });
    return transaction;
  }

  async computeBalance(accountId: string, tx?: Prisma.TransactionClient) {
    const mostRecentEntry = await (tx ?? this.prisma).ledgerEntry.findFirst({
      where: { accountId },
      orderBy: { id: 'desc' },
      take: 1,
    });
    if (mostRecentEntry?.runningBalance)
      return Number(mostRecentEntry.runningBalance);

    const {
      _sum: { amount },
    } = await (tx ?? this.prisma).ledgerEntry.aggregate({
      _sum: { amount: true },
      where: { accountId },
    });

    return Number(amount ?? 0) + BASE_ACCOUNT_AMOUNT;
  }

  private hashRequest(idempotencyKey: string, dto: CreateTransactionDto) {
    return hash(JSON.stringify({ idempotencyKey, ...dto }));
  }
}
