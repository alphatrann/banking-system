import { EventStatus } from '@prisma/client';
import { ReceiptsService } from './receipts.service';
import { PrismaService } from '../prisma/prisma.service';
import { ConfigService } from '@nestjs/config';

describe('ReceiptsService', () => {
  let service: ReceiptsService;
  let prisma: {
    receipt: { updateMany: jest.Mock; update: jest.Mock };
    file: { upsert: jest.Mock };
  };
  let minio: { makeBucket: jest.Mock; putObject: jest.Mock };
  let configService: { getOrThrow: jest.Mock };

  const dto = {
    receiptNumber: 42,
    amount: 1000,
    fromAccountId: 'acc_from',
    toAccountId: 'acc_to',
    timestamp: new Date('2026-01-01T00:00:00.000Z'),
  };

  beforeEach(() => {
    prisma = {
      receipt: {
        updateMany: jest.fn(),
        update: jest.fn(),
      },
      file: { upsert: jest.fn() },
    };
    minio = {
      makeBucket: jest.fn().mockResolvedValue(undefined),
      putObject: jest.fn().mockResolvedValue(undefined),
    };
    configService = { getOrThrow: jest.fn() };

    service = new ReceiptsService(
      minio as any,
      configService as unknown as ConfigService,
      prisma as unknown as PrismaService,
    );
  });

  it('returns { duplicate: true } and does not touch minio/file when the claim updateMany affects 0 rows', async () => {
    prisma.receipt.updateMany.mockResolvedValue({ count: 0 });

    const result = await service.generateReceipt(dto as any);

    expect(result).toEqual({ duplicate: true });
    expect(prisma.receipt.updateMany).toHaveBeenCalledWith({
      where: {
        number: dto.receiptNumber,
        status: { not: EventStatus.Done },
      },
      data: {
        status: EventStatus.Processing,
        generatedAt: expect.any(Date) as Date,
      },
    });
    expect(minio.makeBucket).not.toHaveBeenCalled();
    expect(minio.putObject).not.toHaveBeenCalled();
    expect(prisma.file.upsert).not.toHaveBeenCalled();
    expect(prisma.receipt.update).not.toHaveBeenCalled();
  });

  it('proceeds to generate and mark Done when the claim succeeds', async () => {
    prisma.receipt.updateMany.mockResolvedValue({ count: 1 });
    configService.getOrThrow.mockImplementation((key: string) => {
      if (key === 'WEBHOOK_ENC_ACTIVE_KEY_VERSION') return '1';
      if (key === 'WEBHOOK_ENC_MASTER_KEY_V1') {
        return Buffer.alloc(32, 1).toString('base64');
      }
      throw new Error(`unexpected config key ${key}`);
    });
    prisma.file.upsert.mockResolvedValue({});
    prisma.receipt.update.mockResolvedValue({});

    const result = await service.generateReceipt(dto as any);

    expect(result).toEqual({ duplicate: false });
    expect(minio.putObject).toHaveBeenCalled();
    expect(prisma.file.upsert).toHaveBeenCalled();
    expect(prisma.receipt.update).toHaveBeenCalledWith({
      where: { number: dto.receiptNumber },
      data: { status: EventStatus.Done },
    });
  });
});
