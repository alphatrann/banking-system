import { HttpException, HttpStatus } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { TransactionsService } from './transactions.service';
import { PrismaService } from '../prisma/prisma.service';
import { WebhooksService } from '../webhooks/webhooks.service';
import { LedgerService } from './ledger.service';
import { IdempotencyService } from './idempotency.service';

function serializationFailureError() {
  return new Prisma.PrismaClientKnownRequestError('could not serialize', {
    code: 'P2034',
    clientVersion: 'test',
  });
}

describe('TransactionsService', () => {
  let service: TransactionsService;
  let prisma: { $transaction: jest.Mock };
  let webhooksService: { findRegisteredEndpointIds: jest.Mock };
  let ledger: { computeBalance: jest.Mock; createLedgerEntries: jest.Mock };
  let idempotency: {
    hashRequest: jest.Mock;
    checkIdempotency: jest.Mock;
    complete: jest.Mock;
  };

  // Minimal fake Prisma.TransactionClient: enough surface for
  // decideTransfer/writeFailureOutbox/insertOutbox to run against.
  function makeTx() {
    return {
      receipt: {
        create: jest.fn().mockResolvedValue({ number: BigInt(7) }),
      },
      outboxEvent: { createMany: jest.fn().mockResolvedValue({ count: 0 }) },
      $executeRawUnsafe: jest.fn().mockResolvedValue(undefined),
    };
  }

  beforeEach(() => {
    prisma = { $transaction: jest.fn() };
    webhooksService = {
      findRegisteredEndpointIds: jest.fn().mockResolvedValue([]),
    };
    ledger = {
      computeBalance: jest.fn(),
      createLedgerEntries: jest.fn(),
    };
    idempotency = {
      hashRequest: jest.fn().mockReturnValue('hash_1'),
      checkIdempotency: jest.fn().mockResolvedValue(undefined),
      complete: jest.fn().mockResolvedValue(undefined),
    };

    service = new TransactionsService(
      prisma as unknown as PrismaService,
      webhooksService as unknown as WebhooksService,
      ledger as unknown as LedgerService,
      idempotency as unknown as IdempotencyService,
    );
  });

  it('rejects a transfer to the same account without touching the ledger', async () => {
    const tx = makeTx();
    prisma.$transaction.mockImplementation(
      async (callback: (tx: unknown) => Promise<unknown>) => await callback(tx),
    );
    ledger.computeBalance.mockResolvedValue(1000);

    const dto = { toAccountId: 'acc_1', amount: 100 };

    await expect(
      service.transferMoney(dto as any, 'key_1', 'acc_1'),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        statusCode: HttpStatus.BAD_REQUEST,
        error: 'Source account and destination account must be different',
      }) as Record<string, unknown>,
    });

    expect(ledger.createLedgerEntries).not.toHaveBeenCalled();
    expect(idempotency.complete).toHaveBeenCalledWith(
      'acc_1',
      'key_1',
      expect.objectContaining({ statusCode: HttpStatus.BAD_REQUEST }),
      tx,
    );
  });

  it('rejects a transfer that exceeds the available balance', async () => {
    const tx = makeTx();
    prisma.$transaction.mockImplementation(
      async (callback: (tx: unknown) => Promise<unknown>) => await callback(tx),
    );
    ledger.computeBalance.mockResolvedValue(50);

    const dto = { toAccountId: 'acc_2', amount: 100 };

    await expect(
      service.transferMoney(dto as any, 'key_1', 'acc_1'),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        statusCode: HttpStatus.BAD_REQUEST,
        error: 'Insufficient balance',
      }) as Record<string, unknown>,
    });

    expect(ledger.createLedgerEntries).not.toHaveBeenCalled();
  });

  it('retries on a serialization failure and succeeds on the next attempt', async () => {
    const tx = makeTx();
    let calls = 0;
    prisma.$transaction.mockImplementation(
      async (callback: (tx: unknown) => Promise<unknown>) => {
        calls += 1;
        if (calls === 1) {
          throw serializationFailureError();
        }
        return await callback(tx);
      },
    );

    ledger.computeBalance.mockResolvedValue(1000);
    ledger.createLedgerEntries.mockResolvedValue({
      id: 'txn_1',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    });

    const dto = { toAccountId: 'acc_2', amount: 100 };

    const result = await service.transferMoney(dto as any, 'key_1', 'acc_1');

    expect(calls).toBe(2);
    expect(result).toMatchObject({
      statusCode: HttpStatus.CREATED,
      transaction: { id: 'txn_1', amount: 100 },
    });
  });

  it('gives up after MAX_SERIALIZATION_RETRIES consecutive serialization failures', async () => {
    const tx = makeTx();
    let calls = 0;
    prisma.$transaction.mockImplementation(
      async (callback: (tx: unknown) => Promise<unknown>) => {
        calls += 1;
        // The first 3 calls are the createTransaction retry loop, all of
        // which fail with a serialization error. Once retries are
        // exhausted, TransactionsService falls back to a separate
        // `finalize` transaction to record the failure - that one succeeds.
        if (calls <= 3) {
          throw serializationFailureError();
        }
        return await callback(tx);
      },
    );
    ledger.computeBalance.mockResolvedValue(1000);

    const dto = { toAccountId: 'acc_2', amount: 100 };

    await expect(
      service.transferMoney(dto as any, 'key_1', 'acc_1'),
    ).rejects.toThrow(HttpException);

    expect(calls).toBe(4);
    expect(idempotency.complete).toHaveBeenCalledWith(
      'acc_1',
      'key_1',
      expect.objectContaining({
        statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      }),
      tx,
    );
  });

  it('returns the cached idempotent response without starting a new transaction', async () => {
    const cached = { statusCode: HttpStatus.CREATED, transaction: { id: 'x' } };
    idempotency.checkIdempotency.mockResolvedValue(cached);

    const dto = { toAccountId: 'acc_2', amount: 100 };
    const result = await service.transferMoney(dto as any, 'key_1', 'acc_1');

    expect(result).toBe(cached);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
