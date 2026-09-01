import { Injectable } from '@nestjs/common';
import {
  HealthIndicatorService,
  type HealthIndicatorResult,
} from '@nestjs/terminus';
import { InjectRedis } from '@nestjs-modules/ioredis';
import Redis from 'ioredis';

@Injectable()
export class RedisHealthIndicator {
  constructor(
    @InjectRedis() private readonly redisClient: Redis,
    private readonly healthIndicatorService: HealthIndicatorService,
  ) {}

  async check(key: string): Promise<HealthIndicatorResult> {
    const indicator = this.healthIndicatorService.check(key);

    try {
      if (this.redisClient.status !== 'ready')
        throw new Error(
          `Failed to connect Redis. Status: ${this.redisClient.status}`,
        );
      const pong = await Promise.race([
        this.redisClient.ping(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Redis ping timed out')), 2000),
        ),
      ]);
      if (pong !== 'PONG')
        throw new Error(`Unexpected Redis ping reply: ${pong}`);
      return indicator.up();
    } catch (error) {
      return indicator.down({ message: (error as Error).message });
    }
  }
}
