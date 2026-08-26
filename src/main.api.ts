import { initTracer } from './telemetry';
initTracer('banking-api');

import { ConfigService } from '@nestjs/config';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { watchdog } from './watchdog';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  const MAX_SHUTDOWN_ALLOWANCE_SECONDS = 15;

  app.enableShutdownHooks();

  const configService = app.get(ConfigService);

  // behind 1 proxy: nginx
  if (configService.get('NODE_ENV') === 'production') app.set('trust proxy', 1);

  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));

  const swaggerConfig = new DocumentBuilder()
    .setTitle('Banking System API')
    .setDescription('Documentation for Banking System API')
    .setVersion('1.0')
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('api', app, document);
  watchdog(MAX_SHUTDOWN_ALLOWANCE_SECONDS, 'api');
  await app.listen(5000);
}
bootstrap();
