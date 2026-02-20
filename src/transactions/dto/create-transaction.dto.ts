import { IsInt, IsNotEmpty, IsPositive, IsString } from 'class-validator';

export class CreateTransactionDto {
  @IsString()
  @IsNotEmpty()
  toAccountId: string;

  @IsInt()
  @IsPositive()
  amount: number;
}
