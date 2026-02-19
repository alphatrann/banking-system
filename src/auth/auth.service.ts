import * as argon2 from 'argon2';
import { BadRequestException, Injectable } from '@nestjs/common';
import { AccountsService } from '../users/accounts.service';
import { CreateAccountDto } from '../users/dto/create-account.dto';
import { JwtService } from '@nestjs/jwt';

@Injectable()
export class AuthService {
  constructor(
    private accountsService: AccountsService,
    private jwtService: JwtService,
  ) {}

  async register(dto: CreateAccountDto) {
    const account = await this.accountsService.create(dto);
    return account;
  }

  async createAccessToken(accountId: string) {
    const accessToken = await this.jwtService.signAsync({ sub: accountId });
    return accessToken;
  }

  async login(email: string, password: string) {
    try {
      const account = await this.accountsService.findByEmail(email);
      await this.verifyPassword(account.password, password);
      return account;
    } catch (error) {
      // for security reasons
      throw new BadRequestException({
        success: false,
        message: 'Wrong email or password provided',
      });
    }
  }

  private async verifyPassword(hashed: string, plain: string) {
    const isCorrectPassword = await argon2.verify(hashed, plain);
    if (!isCorrectPassword) throw new BadRequestException();
  }
}
