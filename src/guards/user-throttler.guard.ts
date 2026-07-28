import * as jwt from 'jsonwebtoken';
import { ThrottlerGuard } from '@nestjs/throttler';
import { Request } from 'express';
import { ExecutionContext } from '@nestjs/common';
import { rateLimitHitsTotal } from '../metrics';

export class UserThrottlerGuard extends ThrottlerGuard {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const can = await super.canActivate(context);
    if (!can) rateLimitHitsTotal.add(1);
    return can;
  }

  protected getTracker(req: Request): Promise<string> {
    const authHeader = req.headers?.authorization;

    if (authHeader?.startsWith('Bearer ')) {
      try {
        const token = authHeader.slice(7);
        const payload = jwt.verify(
          token,
          process.env.JWT_SECRET!,
        ) as jwt.JwtPayload;
        return Promise.resolve(`user-${payload.sub}`);
      } catch {
        return Promise.resolve(`ip-${req.ip}`);
      }
    }

    return Promise.resolve(`ip-${req.ip}`);
  }
}
