import { initTracer } from './telemetry';
initTracer('banking-receipt-generator');

import { NestFactory } from '@nestjs/core';
import { ReceiptGeneratorModule } from './receipt-generator/receipt-generator.module';
import { watchdog } from './watchdog';

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(
    ReceiptGeneratorModule,
  );
  const MAX_SHUTDOWN_ALLOWANCE_SECONDS = 20;
  app.enableShutdownHooks();
  watchdog(MAX_SHUTDOWN_ALLOWANCE_SECONDS, 'receipt');
}

bootstrap();
