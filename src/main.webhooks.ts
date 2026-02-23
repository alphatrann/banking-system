import { NestFactory } from '@nestjs/core';
import { WebhooksSenderModule } from './webhooks-sender/webhooks-sender.module';

async function bootstrap() {
  await NestFactory.createApplicationContext(WebhooksSenderModule);
}
bootstrap();
