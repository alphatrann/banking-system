import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { AuthService } from './auth.service';
import { JwtAuthGuard, LocalAuthGuard } from './guards';
import { CurrentUser } from '../users/decorators';
import { type Account } from '@prisma/client';
import { CreateAccountDto } from '../users/dto/create-account.dto';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('register')
  async register(@Body() dto: CreateAccountDto) {
    const newUser = await this.authService.register(dto);
    return { success: true, data: newUser };
  }

  @HttpCode(HttpStatus.OK)
  @UseGuards(LocalAuthGuard)
  @Post('login')
  async login(@CurrentUser() account: Account) {
    const accessToken = await this.authService.createAccessToken(account.id);
    return {
      success: true,
      data: account,
      accessToken,
    };
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  @UseInterceptors()
  me(@CurrentUser() account: Account) {
    return {
      success: true,
      data: account,
    };
  }
}
