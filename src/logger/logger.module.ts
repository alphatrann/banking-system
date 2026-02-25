import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { context, trace } from '@opentelemetry/api';
import { WinstonModule } from 'nest-winston';
import winston from 'winston';
import LokiTransport from 'winston-loki';

const traceFormat = winston.format((info) => {
  const span = trace.getSpan(context.active());

  if (span) {
    const spanContext = span.spanContext();
    info.traceId = spanContext.traceId;
    info.spanId = spanContext.spanId;
  }

  return info;
});

@Module({
  imports: [
    WinstonModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        level:
          configService.get('NODE_ENV') === 'production' ? 'info' : 'debug',
        format: winston.format.combine(
          traceFormat(),
          winston.format.timestamp(),
          winston.format.errors({ stack: true }),
          winston.format.json(),
        ),
        transports: [
          new winston.transports.Console(),
          new LokiTransport({
            host: configService.getOrThrow('LOKI_URL'),
            labels: { app: 'banking-system' },
            json: true,
            interval: 5,
          }),
        ],
      }),
    }),
  ],
  exports: [WinstonModule],
})
export class LoggerModule {}
