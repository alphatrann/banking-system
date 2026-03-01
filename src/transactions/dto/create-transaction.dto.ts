import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsNotEmpty, IsPositive, IsString } from 'class-validator';

export class CreateTransactionDto {
  @IsString()
  @IsNotEmpty()
  @ApiProperty({
    description: 'ID of the destination account',
    example: 'acc_GtfAQ8LW2To42JYf',
  })
  toAccountId: string;

  @IsInt()
  @IsPositive()
  @ApiProperty({
    description: 'Amount in cent (1 USD = 100 cents)',
  })
  amount: number;
}
