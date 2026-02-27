import { seconds, ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import * as Joi from 'joi';
import { PrismaModule } from './prisma/prisma.module';
import { AppService } from './app.service';
import { AppController } from './app.controller';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/accounts.module';
import { TransactionsModule } from './transactions/transactions.module';
import { WebhooksModule } from './webhooks/webhooks.module';
import { LoggerModule } from './logger/logger.module';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { HttpLoggingInterceptor } from './logger/http-logging.interceptor';
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import { UserThrottlerGuard } from './guards/user-throttler.guard';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath:
        process.env.NODE_ENV === 'production'
          ? '.env.production'
          : process.env.NODE_ENV === 'test'
            ? '.env.test.local'
            : '.env.development.local',
      validationSchema: Joi.object({
        DATABASE_URL: Joi.string().required(),
        JWT_SECRET: Joi.string().required(),
        MAIL_TRANSPORT: Joi.string().uri().required(),
      }),
    }),
    UsersModule,
    PrismaModule,
    LoggerModule,
    AuthModule,
    TransactionsModule,
    WebhooksModule,
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        storage: new ThrottlerStorageRedisService(
          configService.getOrThrow('CACHE_URL'),
        ),
        throttlers: [
          {
            name: 'default',
            ttl: seconds(+configService.get('THROTTLE_TTL') || 60),
            limit: +configService.get('THROTTLE_LIMIT') || 100,
          },
        ],
      }),
    }),
  ],
  providers: [
    AppService,
    {
      provide: APP_INTERCEPTOR,
      useClass: HttpLoggingInterceptor,
    },
    {
      provide: APP_GUARD,
      useClass: UserThrottlerGuard,
    },
  ],
  controllers: [AppController],
})
export class AppModule {}
