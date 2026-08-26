import { initTracer } from './telemetry';
initTracer('banking-mail-sender');

import { NestFactory } from '@nestjs/core';
import { MailSenderModule } from './mail-sender/mail-sender.module';
import { watchdog } from './watchdog';

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(MailSenderModule);
  const MAX_SHUTDOWN_ALLOWANCE_SECONDS = 15;
  app.enableShutdownHooks();

  watchdog(MAX_SHUTDOWN_ALLOWANCE_SECONDS, 'mail');
}
bootstrap();
