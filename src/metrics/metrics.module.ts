import { Module } from '@nestjs/common';
import { MetricsService } from './metrics.service';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  providers: [MetricsService],
})
export class MetricsModule {}
