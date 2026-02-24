// THIS MUST BE THE FIRST IMPORT
import tracer from './tracer';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';

async function bootstrap() {
  await tracer.start();
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));

  await app.listen(5000);
}
bootstrap();
