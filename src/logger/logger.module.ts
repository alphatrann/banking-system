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
        transports:
          configService.get('NODE_ENV') === 'test'
            ? [
                new winston.transports.Console({
                  format: winston.format.combine(
                    winston.format.timestamp(),
                    winston.format.json(),
                  ),
                }), // print JSON in the console
              ]
            : [
                new winston.transports.Console({
                  format: winston.format.combine(
                    winston.format.timestamp(),
                    winston.format.json(),
                  ),
                }), // print JSON in the console
                new LokiTransport({
                  replaceTimestamp: true,
                  host: configService.getOrThrow('LOKI_URL'),
                  labels: { app: 'banking-system' },
                  format: winston.format((info) => {
                    info.labels = {
                      level: info.level,
                      component: info.component ?? 'unknown',
                      event: info.message,
                    };
                    return info;
                  })(),
                  interval: 1,
                  batching: false,
                  onConnectionError: (err) => {
                    console.error('Loki error:', err);
                  },
                }),
              ],
      }),
    }),
  ],
  exports: [WinstonModule],
})
export class LoggerModule {}
