import { Module } from '@nestjs/common';
import { QueuesModule } from '../queues/queues.module';
import { OutboxService } from './outbox.service';
import { PrismaModule } from '../prisma/prisma.module';
import { ConfigModule } from '@nestjs/config';
import Joi from 'joi';
import { LoggerModule } from '../logger/logger.module';

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
        CACHE_URL: Joi.string().uri({ scheme: 'redis' }).required(),
      }),
    }),
    QueuesModule,
    PrismaModule,
    LoggerModule,
  ],
  providers: [OutboxService],
})
export class OutboxModule {}
