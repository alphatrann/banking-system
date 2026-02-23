import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DLQName, getQueueJobOptions, QueueName } from './enums';

@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        connection: {
          url: configService.get('CACHE_URL'),
        },
        prefix: configService.get('NODE_ENV'),
      }),
    }),
    ...Object.values(QueueName).map((name) =>
      BullModule.registerQueue({
        name,
        defaultJobOptions: {
          ...getQueueJobOptions(name),
          removeOnComplete: { age: 3600 }, // keep 1 hour
          removeOnFail: false, // do not delete in case adding to DLQ fails
        },
        // }),
      }),
    ),
    ...Object.values(DLQName).map((name) =>
      BullModule.registerQueue({
        name,
        defaultJobOptions: {
          removeOnFail: false,
        },
      }),
    ),
  ],
  exports: [BullModule],
})
export class QueuesModule {}
