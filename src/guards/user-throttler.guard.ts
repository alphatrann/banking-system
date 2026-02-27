import * as jwt from 'jsonwebtoken';
import { ThrottlerGuard } from '@nestjs/throttler';
import { Request } from 'express';

export class UserThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: Request): Promise<string> {
    const authHeader = req.headers?.authorization;

    if (authHeader?.startsWith('Bearer ')) {
      try {
        const token = authHeader.slice(7);
        const payload = jwt.verify(
          token,
          process.env.JWT_SECRET!,
        ) as jwt.JwtPayload;
        console.log(`User ID: ${payload.sub}`);
        return `user-${payload.sub}`;
      } catch {
        return `ip-${req.ip}`;
      }
    }

    return `ip-${req.ip}`;
  }
}
