import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateTransactionDto } from './dto/create-transaction.dto';
import { generateId } from '../utils/id';
import { Prisma, EventStatus } from '@prisma/client';
import {
  isForeignKeyViolation,
  isSerializationFailure,
} from '../prisma/error-codes';
import { buildFailureOutboxJobs, buildSuccessOutboxJobs } from '../utils/jobs';
import { WebhooksService } from '../webhooks/webhooks.service';
import { WebhookEventType } from '../webhooks/enums';
import { LedgerService } from './ledger.service';
import { IdempotencyService } from './idempotency.service';
import {
  context,
  propagation,
  trace,
  SpanStatusCode,
} from '@opentelemetry/api';
import {
  transferDurationSeconds,
  transferFailuresTotal,
  transferRequestsTotal,
  moneyTransferredTotal,
  completedTransfersTotal,
  transferAmountHistogram,
  activeDbTransactions,
  dbTransactionDurationSeconds,
  outboxEventsCreatedTotal,
} from '../metrics';

type TransferResponseBody = {
  statusCode: HttpStatus;
  error?: string;
  transaction?: { id: string; amount: number; createdAt: string };
};

@Injectable()
export class TransactionsService {
  private readonly MAX_SERIALIZATION_RETRIES = 3;
  private readonly TRACER_NAME = 'transactions';

  constructor(
    private readonly prisma: PrismaService,
    private readonly webhooksService: WebhooksService,
    private readonly ledger: LedgerService,
    private readonly idempotency: IdempotencyService,
  ) {}

  async computeBalance(accountId: string) {
    return this.ledger.computeBalance(accountId);
  }

  async transferMoney(
    dto: CreateTransactionDto,
    idempotencyKey: string,
    fromAccountId: string,
  ) {
    transferRequestsTotal.add(1);
    const start = performance.now();
    const tracer = trace.getTracer(this.TRACER_NAME);

    return await tracer.startActiveSpan('money.transfer', async (span) => {
      try {
        span.setAttribute('transaction.amount', dto.amount);
        span.setAttribute('transaction.from_account', fromAccountId);
        span.setAttribute('transaction.to_account', dto.toAccountId);
        span.setAttribute('idempotency_key', idempotencyKey);

        const requestHash = this.idempotency.hashRequest(idempotencyKey, dto);

        const existingResponseBody = await this.idempotency.checkIdempotency(
          fromAccountId,
          idempotencyKey,
          requestHash,
        );

        if (existingResponseBody) return existingResponseBody;

        const { responseBody, finalized } = await this.createTransaction(
          fromAccountId,
          dto,
          new Date(start),
          idempotencyKey,
        );

        // Happy-path and business-rule-failure responses are finalized
        // (idempotency key completed + failure outbox events written)
        // inside the same DB transaction that produced them, so there is
        // no crash window between "transfer decided" and "marked done".
        // Only genuinely unexpected errors (thrown out of the transaction,
        // e.g. a foreign-key race) still need a separate finalize pass.
        if (!finalized) {
          await this.finalize(responseBody, fromAccountId, dto, idempotencyKey);
        }

        if (responseBody.statusCode !== HttpStatus.CREATED) {
          throw new HttpException(responseBody, responseBody.statusCode);
        }

        moneyTransferredTotal.add(dto.amount);
        completedTransfersTotal.add(1);
        transferAmountHistogram.record(dto.amount);

        return responseBody;
      } catch (error: any) {
        if (!(error instanceof HttpException)) {
          span.recordException(error);
          span.setStatus({ code: SpanStatusCode.ERROR });
        }
        throw error;
      } finally {
        transferDurationSeconds.record((performance.now() - start) / 1000);
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
    initiatedAt: Date,
    idempotencyKey: string,
  ): Promise<{ responseBody: TransferResponseBody; finalized: boolean }> {
    const tracer = trace.getTracer(this.TRACER_NAME);

    return await tracer.startActiveSpan('transaction.create', async (span) => {
      try {
        for (
          let attempt = 1;
          attempt <= this.MAX_SERIALIZATION_RETRIES;
          attempt++
        ) {
          const start = performance.now();
          try {
            const responseBody = await this.prisma.$transaction(
              async (tx) => {
                activeDbTransactions.add(1, { operation: 'create_transfer' });
                const fromBalance = await this.ledger.computeBalance(
                  fromAccountId,
                  tx,
                );

                const result = await this.decideTransfer(
                  tx,
                  fromAccountId,
                  dto,
                  fromBalance,
                  initiatedAt,
                );

                // Both the happy path and the business-rule-rejection
                // paths are decided synchronously here, so we can complete
                // the idempotency key and (for failures) write the failure
                // outbox events atomically with everything else.
                if (result.statusCode !== HttpStatus.CREATED) {
                  await this.writeFailureOutbox(tx, fromAccountId, dto, result);
                }
                await this.idempotency.complete(
                  fromAccountId,
                  idempotencyKey,
                  result,
                  tx,
                );

                return result;
              },
              {
                isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
              },
            );
            dbTransactionDurationSeconds.record(
              (performance.now() - start) / 1000,
              { operation: 'create_transfer', attempt, status: 'success' },
            );
            return { responseBody, finalized: true };
          } catch (error: any) {
            dbTransactionDurationSeconds.record(
              (performance.now() - start) / 1000,
              { operation: 'create_transfer', attempt, status: 'failed' },
            );
            if (
              isSerializationFailure(error) &&
              attempt < this.MAX_SERIALIZATION_RETRIES
            ) {
              transferFailuresTotal.add(1, { reason: 'serialization_failure' });
              continue;
            }

            if (isForeignKeyViolation(error)) {
              transferFailuresTotal.add(1, { reason: 'account_not_found' });
              return {
                responseBody: {
                  statusCode: HttpStatus.NOT_FOUND,
                  error: "Destination account doesn't exist",
                },
                finalized: false,
              };
            }

            span.recordException(error);
            span.setStatus({ code: SpanStatusCode.ERROR });

            transferFailuresTotal.add(1, { reason: 'unknown_error' });
            return {
              responseBody: {
                statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
                error: 'Internal error while processing transaction',
              },
              finalized: false,
            };
          }
        }

        // Unreachable: the loop above always returns on its final attempt
        // (the serialization-retry branch only fires while attempt < max).
        // Kept as a defensive guard instead of a non-null assertion so a
        // future change to the retry logic fails loudly instead of
        // returning `undefined` to the caller.
        throw new Error(
          'createTransaction exhausted retries without a terminal result',
        );
      } finally {
        activeDbTransactions.add(-1, { operation: 'create_transfer' });
        span.end();
      }
    });
  }

  private async decideTransfer(
    tx: Prisma.TransactionClient,
    fromAccountId: string,
    dto: CreateTransactionDto,
    fromBalance: number,
    initiatedAt: Date,
  ): Promise<TransferResponseBody> {
    if (dto.toAccountId === fromAccountId) {
      transferFailuresTotal.add(1, { reason: 'same_account' });
      return {
        statusCode: HttpStatus.BAD_REQUEST,
        error: 'Source account and destination account must be different',
      };
    }

    if (dto.amount > fromBalance) {
      transferFailuresTotal.add(1, { reason: 'insufficient_balance' });
      return {
        statusCode: HttpStatus.BAD_REQUEST,
        error: 'Insufficient balance',
      };
    }

    const toBalance = await this.ledger.computeBalance(dto.toAccountId, tx);
    const transaction = await this.ledger.createLedgerEntries(
      fromAccountId,
      tx,
      dto,
      fromBalance,
      toBalance,
      initiatedAt,
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

    const fromEndpoints = await this.webhooksService.findRegisteredEndpointIds(
      WebhookEventType.TransferCompleted,
      fromAccountId,
      tx,
    );

    const toEndpoints = await this.webhooksService.findRegisteredEndpointIds(
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
  }

  private async writeFailureOutbox(
    tx: Prisma.TransactionClient,
    fromAccountId: string,
    dto: CreateTransactionDto,
    responseBody: TransferResponseBody,
  ) {
    const carrier: Record<string, string> = {};
    propagation.inject(context.active(), carrier);

    const fromEndpoints = await this.webhooksService.findRegisteredEndpointIds(
      WebhookEventType.TransferFailed,
      fromAccountId,
      tx,
    );

    const toEndpoints =
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
        responseBody.error ?? 'Unknown error',
        carrier,
      ),
      tx,
    );
  }

  // ===============================
  // Finalization fallback (only reached when the main transaction threw
  // and rolled back before a terminal response body could be decided —
  // e.g. account_not_found races or unexpected errors).
  // ===============================

  private async finalize(
    responseBody: TransferResponseBody,
    fromAccountId: string,
    dto: CreateTransactionDto,
    idempotencyKey: string,
  ) {
    const tracer = trace.getTracer(this.TRACER_NAME);

    return tracer.startActiveSpan('transaction.finalize', async (span) => {
      const start = performance.now();
      try {
        await this.prisma.$transaction(async (tx) => {
          activeDbTransactions.add(1, { operation: 'finalize_transfer' });

          await this.writeFailureOutbox(tx, fromAccountId, dto, responseBody);

          await this.idempotency.complete(
            fromAccountId,
            idempotencyKey,
            responseBody,
            tx,
          );
        });
        dbTransactionDurationSeconds.record(
          (performance.now() - start) / 1000,
          { operation: 'finalize_transfer', status: 'success' },
        );
      } catch (error) {
        dbTransactionDurationSeconds.record(
          (performance.now() - start) / 1000,
          { operation: 'finalize_transfer', status: 'failed' },
        );
        span.recordException(error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
        activeDbTransactions.add(-1, { operation: 'finalize_transfer' });
      }
    });
  }

  private async insertOutbox(
    jobs: Prisma.OutboxEventCreateManyInput[],
    tx?: Prisma.TransactionClient,
  ) {
    const client = tx ?? this.prisma;
    await client.outboxEvent.createMany({ data: jobs });
    outboxEventsCreatedTotal.add(jobs.length);
    await client.$executeRawUnsafe(`NOTIFY outbox_channel`);
  }
}
