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
import type { Account } from '../generated/prisma/client';
import { JwtAuthGuard } from '../auth/guards';

@Controller()
export class TransactionsController {
  constructor(private readonly transactionsService: TransactionsService) {}

  @UseGuards(JwtAuthGuard)
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

  @UseGuards(JwtAuthGuard)
  @Get('balance')
  async getBalance(@CurrentUser() account: Account) {
    const balance = await this.transactionsService.computeBalance(account.id);
    return { balance };
  }
}
