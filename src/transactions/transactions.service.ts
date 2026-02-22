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
import { IdempotencyStatus, Prisma, EventStatus } from '@prisma/client';
import {
  isForeignKeyViolation,
  isSerializationFailure,
  isUniqueViolation,
} from '../prisma/error-codes';
import { BASE_ACCOUNT_AMOUNT } from '../constants';
import { buildFailureOutboxJobs, buildSuccessOutboxJobs } from '../utils/jobs';

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

    // ===============================
    // PHASE 1 — Idempotency Lock
    // ===============================
    try {
      await this.prisma.idempotencyKey.create({
        data: {
          accountId: fromAccountId,
          key: idempotencyKey,
          requestHash,
          status: IdempotencyStatus.Processing,
          responseBody: {},
        },
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;

      const existing = await this.prisma.idempotencyKey.findUnique({
        where: {
          accountId_key: { accountId: fromAccountId, key: idempotencyKey },
        },
      });

      if (!existing) {
        throw new ConflictException('Race condition detected');
      }

      if (existing.requestHash !== requestHash) {
        throw new BadRequestException(
          'Idempotency key reused with different payload',
        );
      }

      // If already completed → replay
      if (existing.status === IdempotencyStatus.Completed) {
        if (existing.responseCode !== HttpStatus.CREATED) {
          throw new HttpException(
            existing.responseBody as object,
            existing.responseCode!,
          );
        }

        return existing.responseBody;
      }

      throw new ConflictException('Request is still processing');
    }

    // ===============================
    // PHASE 2 — Financial Logic
    // ===============================

    for (
      let attempt = 1;
      attempt <= this.MAX_SERIALIZATION_RETRIES;
      attempt++
    ) {
      try {
        await this.prisma.$transaction(
          async (tx) => {
            const transaction = await this.handleTransaction(
              fromAccountId,
              tx,
              dto,
            );

            const { number } = await tx.receipt.create({
              data: {
                transactionId: transaction.id,
                id: generateId('rec'),
                status: EventStatus.Pending,
              },
              select: { number: true },
            });

            responseBody = {
              statusCode: HttpStatus.CREATED,
              transaction: {
                id: transaction.id,
                amount: dto.amount,
                createdAt: transaction.createdAt.toISOString(),
              },
            };

            await this.insertOutbox(
              buildSuccessOutboxJobs(transaction.id, Number(number)),
              tx,
            );
          },
          {
            isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
          },
        );

        break;
      } catch (error: any) {
        if (
          isSerializationFailure(error) &&
          attempt < this.MAX_SERIALIZATION_RETRIES
        ) {
          continue;
        } else if (error instanceof BadRequestException) {
          return error.getResponse();
        } else if (isForeignKeyViolation(error)) {
          responseBody = {
            statusCode: HttpStatus.NOT_FOUND,
            error: "Destination account doesn't exist.",
          };
        } else {
          responseBody = {
            statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
            error: 'Internal error while processing transaction',
          };
        }
        break;
      }
    }

    // ===============================
    // PHASE 3 — Finalize
    // ===============================

    await this.prisma.$transaction(async (tx) => {
      if (responseBody.statusCode !== HttpStatus.CREATED) {
        await this.insertOutbox(buildFailureOutboxJobs(), tx);
      }

      await this.updateIdempotencyKey(
        fromAccountId,
        idempotencyKey,
        responseBody,
        IdempotencyStatus.Completed,
        tx,
      );
    });

    if (responseBody.statusCode !== HttpStatus.CREATED) {
      throw new HttpException(responseBody, responseBody.statusCode);
    }

    return responseBody;
  }

  private async updateIdempotencyKey(
    accountId: string,
    idempotencyKey: string,
    responseBody: any,
    status: IdempotencyStatus,
    tx?: Prisma.TransactionClient,
  ) {
    await (tx ?? this.prisma).idempotencyKey.update({
      where: {
        accountId_key: {
          accountId,
          key: idempotencyKey,
        },
      },
      data: {
        status,
        responseBody,
        responseCode: responseBody.statusCode,
      },
    });
  }

  private async insertOutbox(
    jobs: Prisma.OutboxEventCreateManyInput[],
    tx?: Prisma.TransactionClient,
  ) {
    if (tx) {
      await tx.outboxEvent.createMany({ data: jobs });
      await tx.$executeRawUnsafe(`
      NOTIFY outbox_channel
    `);
    } else {
      await this.prisma.$transaction(async (tx) => {
        await tx.outboxEvent.createMany({ data: jobs });
        await tx.$executeRawUnsafe(`
      NOTIFY outbox_channel
    `);
      });
    }
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

    const transactionId = generateId('txn');

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
