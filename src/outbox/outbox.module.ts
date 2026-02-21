import { Module } from '@nestjs/common';
import { QueuesModule } from '../queues/queues.module';
import { OutboxService } from './outbox.service';
import { PrismaModule } from '../prisma/prisma.module';
import { ConfigModule } from '@nestjs/config';
import Joi from 'joi';

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
        CACHE_URL: Joi.string().uri().required(),
        MAIL_TRANSPORT: Joi.string().uri().required(),
      }),
    }),
    QueuesModule,
    PrismaModule,
  ],
  providers: [OutboxService],
})
export class OutboxModule {}
