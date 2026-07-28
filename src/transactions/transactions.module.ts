import { Module } from '@nestjs/common';
import { TransactionsService } from './transactions.service';
import { TransactionsController } from './transactions.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { WebhooksModule } from '../webhooks/webhooks.module';
import { LedgerService } from './ledger.service';
import { IdempotencyService } from './idempotency.service';

@Module({
  imports: [PrismaModule, WebhooksModule],
  controllers: [TransactionsController],
  providers: [TransactionsService, LedgerService, IdempotencyService],
  exports: [LedgerService],
})
export class TransactionsModule {}
