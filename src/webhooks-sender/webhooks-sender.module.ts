import { Module } from '@nestjs/common';
import { WebhooksModule } from '../webhooks/webhooks.module';
import { QueuesModule } from '../queues/queues.module';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../prisma/prisma.module';
import Joi from 'joi';
import { WebhooksSender } from './webhooks-sender';
import { LoggerModule } from '../logger/logger.module';

@Module({
  imports: [
    WebhooksModule,
    QueuesModule,
    PrismaModule,
    LoggerModule,
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
        CACHE_URL: Joi.string().uri().required(),
      }),
    }),
  ],
  providers: [WebhooksSender],
})
export class WebhooksSenderModule {}
