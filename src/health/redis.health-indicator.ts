import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  HealthIndicatorService,
  type HealthIndicatorResult,
} from '@nestjs/terminus';
import Redis from 'ioredis';

@Injectable()
export class RedisHealthIndicator {
  constructor(
    private readonly configService: ConfigService,
    private readonly healthIndicatorService: HealthIndicatorService,
  ) {}

  async check(key: string): Promise<HealthIndicatorResult> {
    const indicator = this.healthIndicatorService.check(key);
    const client = new Redis(this.configService.getOrThrow('CACHE_URL'), {
      lazyConnect: true,
      connectTimeout: 2000,
      maxRetriesPerRequest: 0,
      retryStrategy: () => null,
    });

    try {
      await client.connect();
      await client.ping();
      return indicator.up();
    } catch (error) {
      return indicator.down({ message: (error as Error).message });
    } finally {
      client.disconnect();
    }
  }
}
