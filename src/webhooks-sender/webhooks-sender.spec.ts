import { UnrecoverableError } from 'bullmq';
import { EventStatus } from '@prisma/client';
import { WebhooksSender } from './webhooks-sender';
import { PrismaService } from '../prisma/prisma.service';
import { WebhooksService } from '../webhooks/webhooks.service';
import { WebhookEventType } from '../webhooks/enums';

describe('WebhooksSender', () => {
  let sender: WebhooksSender;
  let prisma: {
    webhookEvent: { upsert: jest.Mock; update: jest.Mock };
    webhookAttempt: { create: jest.Mock };
  };
  let webhooksService: { findOne: jest.Mock };
  let logger: {
    log: jest.Mock;
    debug: jest.Mock;
    warn: jest.Mock;
    error: jest.Mock;
  };
  let webhooksDLQ: { add: jest.Mock };
  let fetchMock: jest.Mock;

  const endpoint = {
    id: 'whep_1',
    url: 'https://example.com/hook',
    secret: 'shh',
    accountId: 'acc_1',
    active: true,
  };

  function makeJob(overrides: Partial<any> = {}) {
    return {
      id: 'job_1',
      data: {
        endpointId: 'whep_1',
        eventId: 'evt_1',
        _trace: {},
        event: WebhookEventType.TransferCompleted,
        transaction: {
          id: 'txn_1',
          amount: 100,
          toAccountId: 'acc_to',
          fromAccountId: 'acc_from',
          currency: 'USD',
          occurredAt: new Date().toISOString(),
        },
      },
      timestamp: Date.now(),
      attemptsMade: 0,
      opts: { attempts: 20 },
      delay: 0,
      ...overrides,
    };
  }

  beforeEach(() => {
    prisma = {
      webhookEvent: {
        upsert: jest
          .fn()
          .mockResolvedValue({ id: 'evt_1', status: EventStatus.Processing }),
        update: jest.fn().mockResolvedValue({}),
      },
      webhookAttempt: { create: jest.fn().mockResolvedValue({}) },
    };
    webhooksService = { findOne: jest.fn().mockResolvedValue(endpoint) };
    logger = {
      log: jest.fn(),
      debug: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };
    webhooksDLQ = { add: jest.fn().mockResolvedValue({}) };

    sender = new WebhooksSender(
      prisma as unknown as PrismaService,
      webhooksService as unknown as WebhooksService,
      logger as any,
      webhooksDLQ as any,
    );

    fetchMock = jest.fn();
    (global as unknown as { fetch: jest.Mock }).fetch = fetchMock;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('throws a rate_limit error carrying the Retry-After delay (in ms) on a 429 response', async () => {
    fetchMock.mockResolvedValue({
      status: 429,
      headers: {
        get: (name: string) => (name === 'retry-after' ? '30' : null),
      },
      json: () => Promise.resolve({ message: 'slow down' }),
    });

    const job = makeJob();

    expect.assertions(3);
    try {
      await sender.process(job as any);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      const parsed = JSON.parse(message) as { type?: string; delay?: number };
      expect(parsed.type).toBe('rate_limit');
      expect(parsed.delay).toBe(30 * 1000);
    }

    expect(prisma.webhookEvent.update).not.toHaveBeenCalled();
  });

  it('throws UnrecoverableError on a non-429 4xx response (no retry)', async () => {
    fetchMock.mockResolvedValue({
      status: 400,
      headers: { get: () => null },
      json: () => Promise.resolve({ message: 'bad request' }),
    });

    const job = makeJob();

    await expect(sender.process(job as any)).rejects.toThrow(
      UnrecoverableError,
    );
  });

  it('marks the webhook event Done on a successful (2xx) response', async () => {
    fetchMock.mockResolvedValue({
      status: 200,
      headers: { get: () => null },
      json: () => Promise.resolve({ ok: true }),
    });

    const job = makeJob();
    await sender.process(job as any);

    expect(prisma.webhookEvent.update).toHaveBeenCalledWith({
      where: { id: 'evt_1' },
      data: { status: EventStatus.Done },
    });
  });

  it('short-circuits and does not call fetch when the event is already Done (duplicate job)', async () => {
    prisma.webhookEvent.upsert.mockResolvedValue({
      id: 'evt_1',
      status: EventStatus.Done,
    });

    const job = makeJob();
    await sender.process(job as any);

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
