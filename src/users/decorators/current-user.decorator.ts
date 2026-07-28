import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { Request } from 'express';
import { Account } from '@prisma/client';

export const CurrentUser = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): Account => {
    const request = ctx
      .switchToHttp()
      .getRequest<Request & { user: Account }>();
    return request.user;
  },
);
