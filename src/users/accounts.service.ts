import * as argon2 from 'argon2';
import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import { CreateAccountDto } from './dto/create-account.dto';
import { PrismaService } from '../prisma/prisma.service';
import { PostgresErrorCode } from '../prisma/error-codes';
import { Prisma } from '@prisma/client';
import { generateId } from '../utils/id';

@Injectable()
export class AccountsService {
  constructor(private prisma: PrismaService) {}

  async create(dto: CreateAccountDto) {
    try {
      const id = generateId('acc');
      const newAccount = await this.prisma.account.create({
        data: { id, ...dto, password: await argon2.hash(dto.password) },
        omit: { password: true },
      });
      return newAccount;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError) {
        if (error.code === PostgresErrorCode.UniqueConstraintViolation)
          throw new BadRequestException({
            success: false,
            message: 'Account with that email already exists',
          });
      }

      throw new InternalServerErrorException({
        success: false,
        message: 'Something went wrong',
      });
    }
  }

  async findByEmail(email: string) {
    const account = await this.prisma.account.findUnique({ where: { email } });
    if (account) return account;
    throw new BadRequestException({
      success: false,
      message: 'Account with that email does not exist',
    });
  }

  findById(id: string) {
    return this.prisma.account.findUnique({
      where: { id },
      omit: { password: true },
    });
  }
}
