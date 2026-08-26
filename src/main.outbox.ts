import { initTracer } from './telemetry';
initTracer('banking-outbox');

import { NestFactory } from '@nestjs/core';
import { watchdog } from './watchdog';
import { OutboxListenerModule } from './outbox-listener/outbox-listener.module';

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(OutboxListenerModule);
  const MAX_SHUTDOWN_ALLOWANCE_SECONDS = 15;
  app.enableShutdownHooks();

  watchdog(MAX_SHUTDOWN_ALLOWANCE_SECONDS, 'outbox');
}

bootstrap();
