import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { QueueName } from './enums';

@Module({
  imports: [
    ...Object.values(QueueName).map((name) =>
      BullModule.registerQueue({
        name,
        defaultJobOptions: {
          removeOnComplete: true,
          removeOnFail: false,
        },
      }),
    ),
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        connection: {
          url: configService.get('CACHE_URL'),
        },
      }),
    }),
  ],
  exports: [BullModule],
})
export class QueuesModule {}
