import { initTracer } from './telemetry';
initTracer('banking-api');

import { ConfigService } from '@nestjs/config';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  const configService = app.get(ConfigService);

  // behind 1 proxy: nginx
  if (configService.get('NODE_ENV') === 'production') app.set('trust proxy', 1);

  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));

  await app.listen(5000);
}
bootstrap();
