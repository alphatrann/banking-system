import { initTracer } from './telemetry';
initTracer('banking-outbox');

import { Client } from 'pg';
import { NestFactory } from '@nestjs/core';
import { OutboxModule } from './outbox/outbox.module';
import { ConfigService } from '@nestjs/config';
import { OutboxService } from './outbox/outbox.service';

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(OutboxModule);
  const configService = app.get(ConfigService);
  const outboxService = app.get(OutboxService);

  const listener = new Client({
    connectionString: configService.getOrThrow('DATABASE_URL'),
  });

  await listener.connect();
  await listener.query('LISTEN outbox_channel');

  const pollOutbox = () => {
    outboxService.pollOutbox().catch((error: unknown) => {
      console.error('Failed to poll outbox', error);
    });
  };

  listener.on('notification', pollOutbox);
  setInterval(pollOutbox, 5000);
}
bootstrap();
