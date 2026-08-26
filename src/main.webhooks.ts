import { initTracer } from './telemetry';
initTracer('banking-webhook-sender');

import { NestFactory } from '@nestjs/core';
import { WebhooksSenderModule } from './webhooks-sender/webhooks-sender.module';
import { watchdog } from './watchdog';

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(WebhooksSenderModule);
  const MAX_SHUTDOWN_ALLOWANCE_SECONDS = 20;
  app.enableShutdownHooks();

  watchdog(MAX_SHUTDOWN_ALLOWANCE_SECONDS, 'webhooks');
}
bootstrap();
