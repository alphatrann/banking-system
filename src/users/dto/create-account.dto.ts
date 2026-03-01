import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsStrongPassword, Length } from 'class-validator';

export class CreateAccountDto {
  @IsEmail()
  email: string;

  @IsStrongPassword()
  @ApiProperty({
    description:
      'Password should be at least 6 characters long, and contain at least 1 uppercase, 1 numeric and 1 special character',
  })
  password: string;
}
