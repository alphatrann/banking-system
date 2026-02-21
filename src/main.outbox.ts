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
  listener.on('notification', async () => {
    console.log('New outbox event arrived');
    await outboxService.pollOutbox();
  });

  setInterval(async () => {
    await outboxService.pollOutbox();
  }, 5000);
}
bootstrap();
