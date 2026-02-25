import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { ConfigModule } from '@nestjs/config';
import Joi from 'joi';
import { MailModule } from '../mail/mail.module';
import { QueuesModule } from '../queues/queues.module';
import { ReceiptGenerator } from './receipt-generator';
import { ReceiptsModule } from '../receipts/receipts.module';
import { MinioModule } from '../minio/minio.module';
import { WebhooksModule } from '../webhooks/webhooks.module';

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
        MINIO_ENDPOINT: Joi.string().required(),
        MINIO_ACCESS_KEY: Joi.string().required(),
        MINIO_SECRET_KEY: Joi.string().required(),
        MINIO_PORT: Joi.string().required(),
      }),
    }),
    PrismaModule,
    QueuesModule,
    MinioModule,
    MailModule,
    WebhooksModule,
    ReceiptsModule,
  ],
  providers: [ReceiptGenerator],
})
export class ReceiptGeneratorModule {}
