import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { ConfigModule } from '@nestjs/config';
import Joi from 'joi';
import { MailSender } from './mail-sender';
import { MailModule } from '../mail/mail.module';
import { QueuesModule } from '../queues/queues.module';
import { ReceiptsModule } from '../receipts/receipts.module';
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
        MAIL_TRANSPORT: Joi.string().uri().required(),
      }),
    }),
    PrismaModule,
    LoggerModule,
    QueuesModule,
    ReceiptsModule,
    MailModule,
  ],
  providers: [MailSender],
})
export class MailSenderModule {}
