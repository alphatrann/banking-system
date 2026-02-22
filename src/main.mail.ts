import { NestFactory } from '@nestjs/core';
import { MailSenderModule } from './mail-sender/mail-sender.module';

async function bootstrap() {
  await NestFactory.createApplicationContext(MailSenderModule);
}
bootstrap();
