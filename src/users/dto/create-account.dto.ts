import { IsEmail, IsStrongPassword, Length } from 'class-validator';

export class CreateAccountDto {
  @IsEmail()
  email: string;

  @IsStrongPassword()
  password: string;
}
