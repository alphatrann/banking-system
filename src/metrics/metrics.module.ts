import { Module } from '@nestjs/common';
import { MetricsService } from './metrics.service';
import { PrismaModule } from '../prisma/prisma.module';
import { QueuesModule } from '../queues/queues.module';

@Module({
  imports: [PrismaModule, QueuesModule],
  providers: [MetricsService],
})
export class MetricsModule {}
