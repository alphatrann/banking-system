import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { TransactionsService } from './transactions.service';
import { CreateTransactionDto } from './dto/create-transaction.dto';
import { CurrentUser } from '../users/decorators';
import type { Account } from '@prisma/client';
import { JwtAuthGuard } from '../auth/guards';
import { minutes, Throttle } from '@nestjs/throttler';

@Controller()
@UseGuards(JwtAuthGuard)
export class TransactionsController {
  constructor(private readonly transactionsService: TransactionsService) {}

  @Throttle({ default: { limit: 10, ttl: minutes(1) } })
  @Post('transfer')
  async transfer(
    @Body() dto: CreateTransactionDto,
    @CurrentUser() account: Account,
    @Headers('X-Idempotency-Key') idempotencyKey?: string,
  ) {
    if (!idempotencyKey)
      throw new BadRequestException({
        statusCode: HttpStatus.BAD_REQUEST,
        error: 'Missing X-Idempotency-Key in the request header!',
      });
    return await this.transactionsService.transferMoney(
      dto,
      idempotencyKey,
      account.id,
    );
  }

  @Throttle({ default: { limit: 20, ttl: minutes(1) } })
  @Get('balance')
  async getBalance(@CurrentUser() account: Account) {
    const balance = await this.transactionsService.computeBalance(account.id);
    return { balance };
  }
}
