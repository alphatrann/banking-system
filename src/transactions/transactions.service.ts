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
} from '../prisma/error-codes';
import { BASE_ACCOUNT_AMOUNT } from '../constants';

@Injectable()
export class TransactionsService {
  private readonly MAX_SERIALIZATION_RETRIES = 3;

  constructor(private readonly prisma: PrismaService) {}

  async transferMoney(
    dto: CreateTransactionDto,
    idempotencyKey: string,
    ownerAccountId: string,
  ) {
    const requestHash = this.hashRequest(idempotencyKey, dto);

    // 1️⃣ Create or validate idempotency key (outside tx)
    const existing = await this.prisma.idempotencyKey.findUnique({
      where: {
        accountId_key: { accountId: ownerAccountId, key: idempotencyKey },
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

      throw new ConflictException({
        statusCode: HttpStatus.CONFLICT,
        error: 'Request is still processing',
      });
    }

    await this.prisma.idempotencyKey.create({
      data: {
        accountId: ownerAccountId,
        key: idempotencyKey,
        requestHash,
      },
    });

    let responseBody: any;

    // 2️⃣ Run financial logic with SERIALIZABLE retry
    for (
      let attempt = 1;
      attempt <= this.MAX_SERIALIZATION_RETRIES;
      attempt++
    ) {
      try {
        responseBody = await this.prisma.$transaction(
          async (tx) => {
            const fromBalance = await this.computeBalance(ownerAccountId, tx);

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
                        accountId: ownerAccountId,
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

            return {
              statusCode: HttpStatus.CREATED,
              transaction: {
                id: transaction.id,
                amount: dto.amount,
                createdAt: transaction.createdAt.toISOString(),
              },
            };
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

    // 3️⃣ Update idempotency AFTER tx finishes (safe)
    await this.prisma.idempotencyKey.update({
      where: {
        accountId_key: { accountId: ownerAccountId, key: idempotencyKey },
      },
      data: {
        responseBody,
        responseCode: responseBody.statusCode,
      },
    });

    if (responseBody.statusCode !== HttpStatus.CREATED) {
      throw new HttpException(responseBody, responseBody.statusCode);
    }

    return responseBody;
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
