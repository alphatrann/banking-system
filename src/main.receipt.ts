import { initTracer } from './telemetry';
initTracer('banking-receipt-generator');

import { NestFactory } from '@nestjs/core';
import { ReceiptGeneratorModule } from './receipt-generator/receipt-generator.module';

async function bootstrap() {
  await NestFactory.createApplicationContext(ReceiptGeneratorModule);
}
bootstrap();
