import { config } from 'dotenv';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-grpc';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import { PrismaInstrumentation } from '@prisma/instrumentation';

config({
  path:
    process.env.NODE_ENV === 'production'
      ? '.env.production'
      : process.env.NODE_ENV === 'test'
        ? '.env.test.local'
        : '.env.development.local',
});

console.log('OTel collector URL:', process.env.OTEL_COLLECTOR_URL);

export function initTracer(serviceName: string) {
  const traceExporter = new OTLPTraceExporter({
    url: process.env.OTEL_COLLECTOR_URL,
  });

  const metricExporter = new OTLPMetricExporter({
    url: process.env.OTEL_COLLECTOR_URL,
  });

  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: serviceName,
    }),
    traceExporter,
    metricReader: new PeriodicExportingMetricReader({
      exporter: metricExporter,
    }),
    instrumentations: [
      getNodeAutoInstrumentations(),
      new PrismaInstrumentation(),
    ],
  });

  sdk.start();
  process.on('SIGTERM', () => {
    sdk
      .shutdown()
      .then(() => console.log('Tracing terminated'))
      .catch((error) => console.log('Error terminating tracing', error))
      .finally(() => process.exit(0));
  });
}
