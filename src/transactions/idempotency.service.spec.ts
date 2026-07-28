import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { IdempotencyStatus, Prisma } from '@prisma/client';
import { IdempotencyService } from './idempotency.service';
import { PrismaService } from '../prisma/prisma.service';
import { CreateTransactionDto } from './dto/create-transaction.dto';

function uniqueViolationError() {
  return new Prisma.PrismaClientKnownRequestError('unique violation', {
    code: 'P2002',
    clientVersion: 'test',
  });
}

describe('IdempotencyService', () => {
  let service: IdempotencyService;
  let prisma: {
    idempotencyKey: {
      create: jest.Mock;
      findUnique: jest.Mock;
      update: jest.Mock;
    };
  };

  beforeEach(() => {
    prisma = {
      idempotencyKey: {
        create: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    service = new IdempotencyService(prisma as unknown as PrismaService);
  });

  describe('hashRequest', () => {
    it('produces a stable hash for the same key + dto and differs for different input', () => {
      const dto: CreateTransactionDto = {
        toAccountId: 'acc_to',
        amount: 100,
      };
      const h1 = service.hashRequest('key-1', dto);
      const h2 = service.hashRequest('key-1', dto);
      const h3 = service.hashRequest('key-2', dto);

      expect(h1).toBe(h2);
      expect(h1).not.toBe(h3);
    });
  });

  describe('checkIdempotency', () => {
    it('creates a fresh Processing key and returns undefined when no race occurs', async () => {
      prisma.idempotencyKey.create.mockResolvedValue({});

      const result = await service.checkIdempotency('acc_1', 'key_1', 'hash_1');

      expect(result).toBeUndefined();
      expect(prisma.idempotencyKey.create).toHaveBeenCalledWith({
        data: {
          accountId: 'acc_1',
          key: 'key_1',
          requestHash: 'hash_1',
          status: IdempotencyStatus.Processing,
          responseBody: {},
        },
      });
      expect(prisma.idempotencyKey.findUnique).not.toHaveBeenCalled();
    });

    it('rethrows non-unique-violation errors untouched', async () => {
      const error = new Error('some db error');
      prisma.idempotencyKey.create.mockRejectedValue(error);

      await expect(
        service.checkIdempotency('acc_1', 'key_1', 'hash_1'),
      ).rejects.toThrow(error);
    });

    it('throws ConflictException when a unique violation race leaves no existing row', async () => {
      prisma.idempotencyKey.create.mockRejectedValue(uniqueViolationError());
      prisma.idempotencyKey.findUnique.mockResolvedValue(null);

      await expect(
        service.checkIdempotency('acc_1', 'key_1', 'hash_1'),
      ).rejects.toThrow(ConflictException);
    });

    it('throws BadRequestException when the existing key has a different requestHash', async () => {
      prisma.idempotencyKey.create.mockRejectedValue(uniqueViolationError());
      prisma.idempotencyKey.findUnique.mockResolvedValue({
        requestHash: 'different_hash',
        status: IdempotencyStatus.Processing,
      });

      await expect(
        service.checkIdempotency('acc_1', 'key_1', 'hash_1'),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws ConflictException when the existing key is still Processing', async () => {
      prisma.idempotencyKey.create.mockRejectedValue(uniqueViolationError());
      prisma.idempotencyKey.findUnique.mockResolvedValue({
        requestHash: 'hash_1',
        status: IdempotencyStatus.Processing,
      });

      await expect(
        service.checkIdempotency('acc_1', 'key_1', 'hash_1'),
      ).rejects.toThrow(ConflictException);
    });

    it('returns the cached response body when the existing key is Completed with a 201', async () => {
      prisma.idempotencyKey.create.mockRejectedValue(uniqueViolationError());
      const responseBody = { statusCode: HttpStatus.CREATED, foo: 'bar' };
      prisma.idempotencyKey.findUnique.mockResolvedValue({
        requestHash: 'hash_1',
        status: IdempotencyStatus.Completed,
        responseCode: HttpStatus.CREATED,
        responseBody,
      });

      const result = await service.checkIdempotency('acc_1', 'key_1', 'hash_1');

      expect(result).toBe(responseBody);
    });

    it('rethrows the original HttpException when the existing key is Completed with a non-201 responseCode', async () => {
      prisma.idempotencyKey.create.mockRejectedValue(uniqueViolationError());
      const responseBody = {
        statusCode: HttpStatus.BAD_REQUEST,
        error: 'Insufficient balance',
      };
      prisma.idempotencyKey.findUnique.mockResolvedValue({
        requestHash: 'hash_1',
        status: IdempotencyStatus.Completed,
        responseCode: HttpStatus.BAD_REQUEST,
        responseBody,
      });

      const promise = service.checkIdempotency('acc_1', 'key_1', 'hash_1');

      await expect(promise).rejects.toThrow(HttpException);
      await expect(promise).rejects.toMatchObject({
        status: HttpStatus.BAD_REQUEST,
        response: responseBody,
      });
    });
  });

  describe('complete', () => {
    it('marks the idempotency key Completed with the response body and code', async () => {
      const responseBody = { statusCode: HttpStatus.CREATED, ok: true };

      await service.complete('acc_1', 'key_1', responseBody);

      expect(prisma.idempotencyKey.update).toHaveBeenCalledWith({
        where: { accountId_key: { accountId: 'acc_1', key: 'key_1' } },
        data: {
          status: IdempotencyStatus.Completed,
          responseBody,
          responseCode: HttpStatus.CREATED,
        },
      });
    });

    it('uses the provided transaction client when supplied', async () => {
      const txUpdate = jest.fn().mockResolvedValue({});
      const tx = { idempotencyKey: { update: txUpdate } };
      const responseBody = { statusCode: HttpStatus.CREATED };

      await service.complete('acc_1', 'key_1', responseBody, tx as any);

      expect(txUpdate).toHaveBeenCalled();
      expect(prisma.idempotencyKey.update).not.toHaveBeenCalled();
    });
  });
});
