import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { Prisma, IdempotencyStatus } from '@prisma/client';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import { PrismaService } from '../prisma/prisma.service';
import { CreateTransactionDto } from './dto/create-transaction.dto';
import { hash } from '../utils/hash';
import { isUniqueViolation } from '../prisma/error-codes';
import {
  duplicateTransferPreventedTotal,
  transferFailuresTotal,
} from '../metrics';

@Injectable()
export class IdempotencyService {
  private readonly TRACER_NAME = 'transactions';

  constructor(private readonly prisma: PrismaService) {}

  hashRequest(idempotencyKey: string, dto: CreateTransactionDto) {
    return hash(JSON.stringify({ idempotencyKey, ...dto }));
  }

  async checkIdempotency(accountId: string, key: string, requestHash: string) {
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
          transferFailuresTotal.add(1, { reason: 'unknown_error' });
          throw error;
        }

        const existing = await this.prisma.idempotencyKey.findUnique({
          where: {
            accountId_key: { accountId, key },
          },
        });

        if (!existing) {
          transferFailuresTotal.add(1, { reason: 'race_condition' });
          throw new ConflictException('Race condition detected');
        }

        if (existing.requestHash !== requestHash) {
          transferFailuresTotal.add(1, { reason: 'malformed_request' });
          throw new BadRequestException(
            'Idempotency key reused with different payload',
          );
        }

        if (existing.status === IdempotencyStatus.Completed) {
          if (existing.responseCode !== HttpStatus.CREATED) {
            transferFailuresTotal.add(1, { reason: 'existing_error_response' });
            throw new HttpException(
              existing.responseBody as object,
              existing.responseCode!,
            );
          }

          duplicateTransferPreventedTotal.add(1);
          return existing.responseBody;
        }

        transferFailuresTotal.add(1, { reason: 'already_processing' });
        throw new ConflictException('Request is still processing');
      } finally {
        span.end();
      }
    });
  }

  async complete(
    accountId: string,
    key: string,
    responseBody: { statusCode: number; [key: string]: unknown },
    tx?: Prisma.TransactionClient,
  ) {
    await (tx ?? this.prisma).idempotencyKey.update({
      where: { accountId_key: { accountId, key } },
      data: {
        status: IdempotencyStatus.Completed,
        responseBody: responseBody as Prisma.InputJsonValue,
        responseCode: responseBody.statusCode,
      },
    });
  }
}
