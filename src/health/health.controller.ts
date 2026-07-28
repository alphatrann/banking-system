import { Controller, Get } from '@nestjs/common';
import { HealthCheck, HealthCheckService } from '@nestjs/terminus';
import { SkipThrottle } from '@nestjs/throttler';
import { PrismaHealthIndicator } from './prisma.health-indicator';
import { RedisHealthIndicator } from './redis.health-indicator';

@SkipThrottle()
@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly prismaIndicator: PrismaHealthIndicator,
    private readonly redisIndicator: RedisHealthIndicator,
  ) {}

  // Liveness: is the process itself still running? No dependency calls,
  // so an unhealthy DB/Redis doesn't cause a restart-loop.
  @Get('live')
  live() {
    return { status: 'ok' };
  }

  // Readiness: can this instance actually serve traffic right now?
  @Get()
  @HealthCheck()
  ready() {
    return this.health.check([
      () => this.prismaIndicator.check('database'),
      () => this.redisIndicator.check('redis'),
    ]);
  }
}
