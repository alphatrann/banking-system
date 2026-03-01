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
import {
  IdempotencyStatus,
  Prisma,
  EventStatus,
  Transaction,
} from '@prisma/client';
import {
  isForeignKeyViolation,
  isSerializationFailure,
  isUniqueViolation,
} from '../prisma/error-codes';
import { BASE_ACCOUNT_AMOUNT } from '../constants';
import { buildFailureOutboxJobs, buildSuccessOutboxJobs } from '../utils/jobs';
import { WebhooksService } from '../webhooks/webhooks.service';
import { WebhookEventType } from '../webhooks/enums';
import {
  context,
  propagation,
  trace,
  SpanStatusCode,
} from '@opentelemetry/api';

@Injectable()
export class TransactionsService {
  private readonly MAX_SERIALIZATION_RETRIES = 3;
  private readonly TRACER_NAME = 'transactions';

  constructor(
    private readonly prisma: PrismaService,
    private readonly webhooksService: WebhooksService,
  ) {}

  async transferMoney(
    dto: CreateTransactionDto,
    idempotencyKey: string,
    fromAccountId: string,
  ) {
    const tracer = trace.getTracer(this.TRACER_NAME);

    return await tracer.startActiveSpan('money.transfer', async (span) => {
      try {
        span.setAttribute('transaction.amount', dto.amount);
        span.setAttribute('transaction.from_account', fromAccountId);
        span.setAttribute('transaction.to_account', dto.toAccountId);
        span.setAttribute('idempotency_key', idempotencyKey);

        const requestHash = this.hashRequest(idempotencyKey, dto);

        const existingResponseBody = await this.checkIdempotency(
          fromAccountId,
          idempotencyKey,
          requestHash,
        );
        if (existingResponseBody) return existingResponseBody;

        const responseBody = await this.createTransaction(fromAccountId, dto);

        await this.finalize(responseBody, fromAccountId, dto, idempotencyKey);

        if (responseBody.statusCode !== HttpStatus.CREATED) {
          throw new HttpException(responseBody, responseBody.statusCode);
        }

        return responseBody;
      } catch (error: any) {
        if (!(error instanceof HttpException)) {
          span.recordException(error);
          span.setStatus({ code: SpanStatusCode.ERROR });
        }
        throw error;
      } finally {
        span.end();
      }
    });
  }

  // ===============================
  // Idempotency Phase
  // ===============================

  private async checkIdempotency(
    accountId: string,
    key: string,
    requestHash: string,
  ) {
    const tracer = trace.getTracer(this.TRACER_NAME);

    return await tracer.startActiveSpan('idempotency.check', async (span) => {
      try {
        await this.prisma.idempotencyKey.create({
          data: {
            accountId,
            key,
            requestHash,
            status: IdempotencyStatus.Processing,
            responseBody: {},
          },
        });
      } catch (error) {
        if (!isUniqueViolation(error)) {
          span.recordException(error);
          span.setStatus({ code: SpanStatusCode.ERROR });
          throw error;
        }

        const existing = await this.prisma.idempotencyKey.findUnique({
          where: {
            accountId_key: { accountId, key },
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
      } finally {
        span.end();
      }
    });
  }

  // ===============================
  // Transaction Phase
  // ===============================

  private async createTransaction(
    fromAccountId: string,
    dto: CreateTransactionDto,
  ) {
    const tracer = trace.getTracer(this.TRACER_NAME);

    return await tracer.startActiveSpan('transaction.create', async (span) => {
      try {
        let responseBody: {
          statusCode: number;
          error?: string;
          transaction?: { id: string; amount: number; createdAt: string };
        };

        for (
          let attempt = 1;
          attempt <= this.MAX_SERIALIZATION_RETRIES;
          attempt++
        ) {
          try {
            responseBody = await this.prisma.$transaction(
              async (tx) => {
                const fromBalance = await this.computeBalance(
                  fromAccountId,
                  tx,
                );

                if (dto.toAccountId === fromAccountId)
                  return {
                    statusCode: HttpStatus.BAD_REQUEST,
                    error:
                      'Source account and destination account must be different',
                  };

                if (dto.amount > fromBalance) {
                  return {
                    statusCode: HttpStatus.BAD_REQUEST,
                    error: 'Insufficient balance',
                  };
                }

                const toBalance = await this.computeBalance(
                  dto.toAccountId,
                  tx,
                );
                const transaction = await this.handleTransaction(
                  fromAccountId,
                  tx,
                  dto,
                  fromBalance,
                  toBalance,
                );

                const { number } = await tx.receipt.create({
                  data: {
                    transactionId: transaction.id,
                    id: generateId('rec'),
                    status: EventStatus.Pending,
                  },
                  select: { number: true },
                });

                const carrier: Record<string, string> = {};
                propagation.inject(context.active(), carrier);

                const fromEndpoints =
                  await this.webhooksService.findRegisteredEndpointIds(
                    WebhookEventType.TransferCompleted,
                    fromAccountId,
                    tx,
                  );

                const toEndpoints =
                  await this.webhooksService.findRegisteredEndpointIds(
                    WebhookEventType.TransferCompleted,
                    dto.toAccountId,
                    tx,
                  );

                await this.insertOutbox(
                  buildSuccessOutboxJobs(
                    {
                      id: transaction.id,
                      fromAccountId,
                      ...dto,
                      occurredAt: transaction.createdAt.toISOString(),
                      currency: 'USD',
                    },
                    Number(number),
                    [...fromEndpoints, ...toEndpoints],
                    carrier,
                  ),
                  tx,
                );

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

            return responseBody;
          } catch (error: any) {
            if (
              isSerializationFailure(error) &&
              attempt < this.MAX_SERIALIZATION_RETRIES
            ) {
              continue;
            }

            if (error instanceof BadRequestException) {
              return {
                statusCode: error.getStatus(),
                error: error.message,
              };
            }

            if (isForeignKeyViolation(error)) {
              return {
                statusCode: HttpStatus.NOT_FOUND,
                error: "Destination account doesn't exist",
              };
            }

            span.recordException(error);
            span.setStatus({ code: SpanStatusCode.ERROR });

            return {
              statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
              error: 'Internal error while processing transaction',
            };
          }
        }

        return responseBody!;
      } finally {
        span.end();
      }
    });
  }

  // ===============================
  // Finalization Phase
  // ===============================

  private async finalize(
    responseBody: any,
    fromAccountId: string,
    dto: CreateTransactionDto,
    idempotencyKey: string,
  ) {
    const tracer = trace.getTracer(this.TRACER_NAME);

    return tracer.startActiveSpan('transaction.finalize', async (span) => {
      try {
        await this.prisma.$transaction(async (tx) => {
          if (responseBody.statusCode !== HttpStatus.CREATED) {
            const carrier: Record<string, string> = {};
            propagation.inject(context.active(), carrier);

            const fromEndpoints =
              await this.webhooksService.findRegisteredEndpointIds(
                WebhookEventType.TransferFailed,
                fromAccountId,
                tx,
              );

            const toEndpoints =
              responseBody.statusCode === HttpStatus.NOT_FOUND ||
              dto.toAccountId === fromAccountId
                ? []
                : await this.webhooksService.findRegisteredEndpointIds(
                    WebhookEventType.TransferFailed,
                    dto.toAccountId,
                    tx,
                  );

            await this.insertOutbox(
              buildFailureOutboxJobs(
                {
                  id: generateId('txn'),
                  ...dto,
                  currency: 'USD',
                  fromAccountId,
                  occurredAt: new Date().toISOString(),
                },
                [...fromEndpoints, ...toEndpoints],
                responseBody.statusCode,
                responseBody.error,
                carrier,
              ),
              tx,
            );
          }

          await this.updateIdempotencyKey(
            fromAccountId,
            idempotencyKey,
            responseBody,
            IdempotencyStatus.Completed,
            tx,
          );
        });
      } catch (error) {
        span.recordException(error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
  }

  // ===============================
  // Domain Logic
  // ===============================

  private async handleTransaction(
    fromAccountId: string,
    tx: Prisma.TransactionClient,
    dto: CreateTransactionDto,
    fromBalance: number,
    toBalance: number,
  ) {
    return tx.transaction.create({
      data: {
        id: generateId('txn'),
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
  }

  async computeBalance(accountId: string, tx?: Prisma.TransactionClient) {
    const mostRecentEntry = await (tx ?? this.prisma).ledgerEntry.findFirst({
      where: { accountId },
      orderBy: { id: 'desc' },
      take: 1,
    });

    if (mostRecentEntry?.runningBalance) {
      return Number(mostRecentEntry.runningBalance);
    }

    const {
      _sum: { amount },
    } = await (tx ?? this.prisma).ledgerEntry.aggregate({
      _sum: { amount: true },
      where: { accountId },
    });

    return Number(amount ?? 0) + BASE_ACCOUNT_AMOUNT;
  }

  private async updateIdempotencyKey(
    accountId: string,
    key: string,
    responseBody: any,
    status: IdempotencyStatus,
    tx?: Prisma.TransactionClient,
  ) {
    await (tx ?? this.prisma).idempotencyKey.update({
      where: { accountId_key: { accountId, key } },
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
    const client = tx ?? this.prisma;
    await client.outboxEvent.createMany({ data: jobs });
    await client.$executeRawUnsafe(`NOTIFY outbox_channel`);
  }

  private hashRequest(idempotencyKey: string, dto: CreateTransactionDto) {
    return hash(JSON.stringify({ idempotencyKey, ...dto }));
  }
}
