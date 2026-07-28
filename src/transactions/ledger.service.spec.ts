import { InternalServerErrorException } from '@nestjs/common';
import { LedgerService } from './ledger.service';
import { PrismaService } from '../prisma/prisma.service';
import { BASE_ACCOUNT_AMOUNT } from '../constants';

describe('LedgerService', () => {
  let service: LedgerService;
  let prisma: {
    ledgerEntry: {
      findFirst: jest.Mock;
      aggregate: jest.Mock;
    };
  };

  beforeEach(() => {
    prisma = {
      ledgerEntry: {
        findFirst: jest.fn(),
        aggregate: jest.fn(),
      },
    };
    service = new LedgerService(prisma as unknown as PrismaService);
  });

  describe('computeBalance', () => {
    it('uses the cached runningBalance on the most recent ledger entry', async () => {
      prisma.ledgerEntry.findFirst.mockResolvedValue({
        runningBalance: BigInt(12345),
      });

      const balance = await service.computeBalance('acc_1');

      expect(balance).toBe(12345);
      expect(prisma.ledgerEntry.findFirst).toHaveBeenCalledWith({
        where: { accountId: 'acc_1' },
        orderBy: { id: 'desc' },
        take: 1,
      });
      expect(prisma.ledgerEntry.aggregate).not.toHaveBeenCalled();
    });

    it('falls back to aggregate sum + BASE_ACCOUNT_AMOUNT when no entries exist', async () => {
      prisma.ledgerEntry.findFirst.mockResolvedValue(null);
      prisma.ledgerEntry.aggregate.mockResolvedValue({
        _sum: { amount: BigInt(1000) },
      });

      const balance = await service.computeBalance('acc_2');

      expect(balance).toBe(1000 + BASE_ACCOUNT_AMOUNT);
      expect(prisma.ledgerEntry.aggregate).toHaveBeenCalledWith({
        _sum: { amount: true },
        where: { accountId: 'acc_2' },
      });
    });

    it('falls back to BASE_ACCOUNT_AMOUNT when aggregate sum is null (brand new account)', async () => {
      prisma.ledgerEntry.findFirst.mockResolvedValue(null);
      prisma.ledgerEntry.aggregate.mockResolvedValue({
        _sum: { amount: null },
      });

      const balance = await service.computeBalance('acc_3');

      expect(balance).toBe(BASE_ACCOUNT_AMOUNT);
    });

    it('throws InternalServerErrorException when the cached balance exceeds the safe integer range', async () => {
      prisma.ledgerEntry.findFirst.mockResolvedValue({
        runningBalance: BigInt(Number.MAX_SAFE_INTEGER) + BigInt(1),
      });

      await expect(service.computeBalance('acc_4')).rejects.toThrow(
        InternalServerErrorException,
      );
    });

    it('throws InternalServerErrorException when the cached balance is below the safe integer range', async () => {
      prisma.ledgerEntry.findFirst.mockResolvedValue({
        runningBalance: BigInt(Number.MIN_SAFE_INTEGER) - BigInt(1),
      });

      await expect(service.computeBalance('acc_5')).rejects.toThrow(
        InternalServerErrorException,
      );
    });

    it('throws InternalServerErrorException when the aggregated sum exceeds the safe integer range', async () => {
      prisma.ledgerEntry.findFirst.mockResolvedValue(null);
      prisma.ledgerEntry.aggregate.mockResolvedValue({
        _sum: { amount: BigInt(Number.MAX_SAFE_INTEGER) + BigInt(1) },
      });

      await expect(service.computeBalance('acc_6')).rejects.toThrow(
        InternalServerErrorException,
      );
    });

    it('uses the provided transaction client when supplied', async () => {
      const txFindFirst = jest.fn().mockResolvedValue({
        runningBalance: BigInt(50),
      });
      const tx = {
        ledgerEntry: { findFirst: txFindFirst, aggregate: jest.fn() },
      };

      const balance = await service.computeBalance('acc_7', tx as any);

      expect(balance).toBe(50);
      expect(txFindFirst).toHaveBeenCalled();
      expect(prisma.ledgerEntry.findFirst).not.toHaveBeenCalled();
    });
  });

  describe('createLedgerEntries', () => {
    it('creates a transaction with debit/credit ledger entries reflecting the new balances', async () => {
      const createdAt = new Date('2026-01-01T00:00:00.000Z');
      const txCreate = jest.fn().mockResolvedValue({
        id: 'txn_1',
        createdAt,
      });
      const tx = { transaction: { create: txCreate } };

      const dto = { toAccountId: 'acc_to', amount: 100 };
      const result = await service.createLedgerEntries(
        'acc_from',
        tx as any,
        dto as any,
        500,
        200,
        createdAt,
      );

      expect(result).toEqual({ id: 'txn_1', createdAt });
      expect(txCreate).toHaveBeenCalledWith({
        data: expect.objectContaining({
          initiatedAt: createdAt,
          ledgerEntries: {
            createMany: {
              data: [
                {
                  accountId: 'acc_from',
                  amount: -100,
                  runningBalance: 400,
                },
                {
                  accountId: 'acc_to',
                  amount: 100,
                  runningBalance: 300,
                },
              ],
            },
          },
        }) as Record<string, unknown>,
      });
    });
  });
});
