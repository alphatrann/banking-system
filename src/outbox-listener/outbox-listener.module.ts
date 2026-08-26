import { Module } from '@nestjs/common';
import { OutboxListenerService } from './outbox-listener.service';
import { LoggerModule } from 'src/logger/logger.module';
import { OutboxModule } from 'src/outbox/outbox.module';

@Module({
  imports: [LoggerModule, OutboxModule],
  providers: [OutboxListenerService],
})
export class OutboxListenerModule {}
