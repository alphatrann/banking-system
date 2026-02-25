import {
  InjectQueue,
  OnWorkerEvent,
  Processor,
  WorkerHost,
} from '@nestjs/bullmq';
import { QueueName } from '../queues/enums';
import { HttpStatus, Injectable } from '@nestjs/common';
import { BackoffStrategy, Job, Queue, UnrecoverableError } from 'bullmq';
import { SendWebhookJobPayload } from '../outbox/interfaces/job-payload';
import { PrismaService } from '../prisma/prisma.service';
import { WebhooksService } from '../webhooks/webhooks.service';
import { unix } from '../utils/timer';
import { hmac } from '../utils/hash';
import { EventStatus } from '@prisma/client';
import { WEBHOOK_TIMEOUT_MS } from '../constants';
import { formatError } from '../utils/formatter';
import {
  propagation,
  ROOT_CONTEXT,
  SpanStatusCode,
  trace,
} from '@opentelemetry/api';

const backoffStrategy: BackoffStrategy = (attemptsMade, type, err) => {
  try {
    const parsed = JSON.parse(err!.message);
    if (parsed?.delay) {
      console.log('Retry-After:', parsed.delay);
      return parsed.delay;
    }
  } catch {}

  const backoff = Math.min(
    2 ** attemptsMade * 1000 * (1 + Math.random()),
    5 * 60_000,
  );
  console.log('Exponential Delay:', backoff);
  return backoff;
};

@Processor(QueueName.Webhooks, {
  limiter: { max: 1000, duration: 60000 },
  concurrency: 4,
  settings: { backoffStrategy },
})
@Injectable()
export class WebhooksSender extends WorkerHost {
  private readonly TRACE_NAME = 'webhooks-sender';

  constructor(
    private prisma: PrismaService,
    private webhooksService: WebhooksService,
    @InjectQueue(QueueName.Webhooks) private webhooksDLQ: Queue,
  ) {
    super();
  }

  async process(job: Job<SendWebhookJobPayload>): Promise<void> {
    const { endpointId, eventId, _trace, ...payload } = job.data;
    const tracer = trace.getTracer(this.TRACE_NAME);
    const parentCtx = propagation.extract(ROOT_CONTEXT, _trace ?? {});
    const parentSpanContext = trace.getSpanContext(parentCtx);

    await tracer.startActiveSpan(
      'webhooks.send',
      {
        links: parentSpanContext ? [{ context: parentSpanContext }] : [],
      },
      async (span) => {
        try {
          const webhookEndpoint =
            await this.webhooksService.findOne(endpointId);
          if (!webhookEndpoint)
            throw new UnrecoverableError('Webhook endpoint not found');
          span.setAttribute('webhook.url', webhookEndpoint.url);
          span.setAttribute('webhook.account_id', webhookEndpoint.accountId);
          span.setAttribute('webhook.payload', JSON.stringify(payload));
          span.setAttribute('webhook.attempts_made', job.attemptsMade);
          span.setAttribute('webhook.event_name', payload.event);
          const timestamp = unix();

          const body = { id: eventId, timestamp, ...payload };
          const jsonBody = JSON.stringify(body);
          const signedPayload = `${timestamp}.${jsonBody}`;
          const signature = hmac(signedPayload, webhookEndpoint.secret);

          const event = await this.prisma.webhookEvent.upsert({
            where: { id: eventId },
            create: {
              id: eventId,
              eventType: payload.event,
              payload: payload as any,
              endpointId,
              status: EventStatus.Processing,
            },
            update: {},
          });
          if (event.status === EventStatus.Done) return;

          await tracer.startActiveSpan('webhooks.http', async (span) => {
            const requestSentAtMs = Date.now();
            try {
              await this.handleRequest(
                webhookEndpoint.url,
                eventId,
                timestamp,
                signature,
                jsonBody,
              );
            } catch (error: any) {
              if (error instanceof UnrecoverableError) throw error;
              span.setStatus({ code: SpanStatusCode.ERROR });
              span.recordException(error);
              await this.prisma.webhookAttempt.create({
                data: {
                  durationMs: Date.now() - requestSentAtMs,
                  error: formatError(error),
                  webhookEventId: eventId,
                },
              });
              throw error;
            } finally {
              span.end();
            }
          });
        } catch (error) {
          span.setStatus({ code: SpanStatusCode.ERROR });
          span.recordException(error);
          throw error;
        } finally {
          span.end();
        }
      },
    );
  }

  private async handleRequest(
    url: string,
    eventId: string,
    timestamp: number,
    signature: string,
    jsonBody: string,
  ) {
    const requestSentAtMs = Date.now();
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Signature': `t=${timestamp},v1=${signature}`,
        'X-Event-ID': eventId,
      },
      body: jsonBody,
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    });
    const body = await response.json();
    await this.prisma.webhookAttempt.create({
      data: {
        durationMs: Date.now() - requestSentAtMs,
        responseBody: body,
        responseStatus: response.status,
        webhookEventId: eventId,
      },
    });

    if (response.status < HttpStatus.BAD_REQUEST) {
      await this.prisma.webhookEvent.update({
        where: { id: eventId },
        data: { status: EventStatus.Done },
      });
    } else {
      const retryAfter = response.headers.get('retry-after');
      await this.handleFailure(response.status, retryAfter);
    }
  }

  private async handleFailure(
    statusCode: HttpStatus,
    retryAfter: string | null,
  ) {
    if (statusCode < HttpStatus.BAD_REQUEST) return;
    if (statusCode < HttpStatus.INTERNAL_SERVER_ERROR) {
      if (statusCode === HttpStatus.TOO_MANY_REQUESTS) {
        let retryAfterMs: number | undefined;
        if (retryAfter) {
          if (isNaN(parseInt(retryAfter))) {
            const retryAfterDate = new Date(retryAfter);
            retryAfterMs = retryAfterDate.getTime() - Date.now();
          } else {
            retryAfterMs = parseInt(retryAfter) * 1000;
          }
        }
        throw new Error(
          JSON.stringify({
            type: 'rate_limit',
            delay: retryAfterMs,
          }),
        );
      } else
        throw new UnrecoverableError(
          `Client error with status code ${statusCode}`,
        );
    } else {
      throw new Error(`Service error with status code ${statusCode}`);
    }
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job<SendWebhookJobPayload>, error: Error) {
    const { eventId, _trace } = job.data;
    const tracer = trace.getTracer(this.TRACE_NAME);
    const parentCtx = propagation.extract(ROOT_CONTEXT, _trace);
    const parentSpanContext = trace.getSpanContext(parentCtx);

    console.log(
      `Job ${job.id} failed, attempts made=${job.attemptsMade}/${job.opts.attempts}. Retry after ${job.delay}ms`,
    );
    console.error(`Reason: ${error}`);
    const noMoreRetry =
      job.attemptsMade === job.opts.attempts! ||
      error instanceof UnrecoverableError;
    if (noMoreRetry) {
      await tracer.startActiveSpan(
        'webhook.dlq',
        { links: parentSpanContext ? [{ context: parentSpanContext }] : [] },
        async (span) => {
          try {
            await this.prisma.webhookEvent.update({
              where: { id: eventId },
              data: {
                attemptCount: job.attemptsMade,
                status: EventStatus.Failed,
              },
            });
            await this.webhooksDLQ.add(job.name, job.data, job.opts);
          } catch (error) {
            span.setStatus({ code: SpanStatusCode.ERROR });
            span.recordException(error);
            throw error;
          } finally {
            span.end();
          }
        },
      );
    } else {
      await tracer.startActiveSpan(
        'webhook.retry',
        { links: parentSpanContext ? [{ context: parentSpanContext }] : [] },
        async (span) => {
          try {
            await this.prisma.webhookEvent.update({
              where: { id: eventId },
              data: { attemptCount: job.attemptsMade },
            });
          } catch (error) {
            span.setStatus({ code: SpanStatusCode.ERROR });
            span.recordException(error);
            throw error;
          } finally {
            span.end();
          }
        },
      );
    }
  }
}
