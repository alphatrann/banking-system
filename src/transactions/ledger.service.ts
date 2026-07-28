import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateTransactionDto } from './dto/create-transaction.dto';
import { generateId } from '../utils/id';
import { BASE_ACCOUNT_AMOUNT } from '../constants';
import {
  ledgerEntriesCreatedTotal,
  ledgerQueryDurationSeconds,
} from '../metrics';

/**
 * Converts a ledger BigInt amount to a Number, refusing to silently lose
 * precision if the value falls outside JS's safe integer range.
 */
function toSafeNumber(value: bigint): number {
  if (
    value > BigInt(Number.MAX_SAFE_INTEGER) ||
    value < BigInt(Number.MIN_SAFE_INTEGER)
  ) {
    throw new InternalServerErrorException(
      'Ledger amount exceeds safely representable range',
    );
  }
  return Number(value);
}

@Injectable()
export class LedgerService {
  constructor(private readonly prisma: PrismaService) {}

  async computeBalance(accountId: string, tx?: Prisma.TransactionClient) {
    const start = performance.now();
    const mostRecentEntry = await (tx ?? this.prisma).ledgerEntry.findFirst({
      where: { accountId },
      orderBy: { id: 'desc' },
      take: 1,
    });

    if (mostRecentEntry) {
      return toSafeNumber(mostRecentEntry.runningBalance);
    }

    const {
      _sum: { amount },
    } = await (tx ?? this.prisma).ledgerEntry.aggregate({
      _sum: { amount: true },
      where: { accountId },
    });

    ledgerQueryDurationSeconds.record((performance.now() - start) / 1000);
    return toSafeNumber(amount ?? BigInt(0)) + BASE_ACCOUNT_AMOUNT;
  }

  async createLedgerEntries(
    fromAccountId: string,
    tx: Prisma.TransactionClient,
    dto: CreateTransactionDto,
    fromBalance: number,
    toBalance: number,
    initiatedAt: Date,
  ) {
    const transaction = await tx.transaction.create({
      data: {
        id: generateId('txn'),
        initiatedAt,
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
    ledgerEntriesCreatedTotal.add(2);
    return transaction;
  }
}
