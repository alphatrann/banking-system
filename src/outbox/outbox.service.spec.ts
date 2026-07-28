import { OutboxEventStatus } from '@prisma/client';
import { OutboxService } from './outbox.service';
import { PrismaService } from '../prisma/prisma.service';
import { EventType } from '../queues/enums';
import { WebhookEventType } from '../webhooks/enums';
import { OUTBOX_MAX_ATTEMPTS } from '../constants';

describe('OutboxService', () => {
  let service: OutboxService;
  let prisma: {
    $queryRaw: jest.Mock;
    outboxEvent: { updateMany: jest.Mock };
  };
  let logger: {
    log: jest.Mock;
    debug: jest.Mock;
    warn: jest.Mock;
    error: jest.Mock;
  };
  let webhooksQueue: { add: jest.Mock };
  let emailsQueue: { add: jest.Mock };
  let receiptsQueue: { add: jest.Mock };

  function makeJob(overrides: Partial<any> = {}) {
    return {
      id: 'evt_1',
      event_type: WebhookEventType.TransferCompleted,
      created_at: new Date(),
      attempt_count: 1,
      payload: { foo: 'bar' },
      trace_context: {},
      ...overrides,
    };
  }

  beforeEach(() => {
    prisma = {
      $queryRaw: jest.fn(),
      outboxEvent: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
    };
    logger = {
      log: jest.fn(),
      debug: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };
    webhooksQueue = { add: jest.fn().mockResolvedValue(undefined) };
    emailsQueue = { add: jest.fn().mockResolvedValue(undefined) };
    receiptsQueue = { add: jest.fn().mockResolvedValue(undefined) };

    service = new OutboxService(
      prisma as unknown as PrismaService,
      logger as any,
      webhooksQueue as any,
      emailsQueue as any,
      receiptsQueue as any,
    );
  });

  it('does nothing when there are no claimed rows', async () => {
    prisma.$queryRaw.mockResolvedValue([]);

    await service.pollOutbox();

    expect(webhooksQueue.add).not.toHaveBeenCalled();
    expect(prisma.outboxEvent.updateMany).not.toHaveBeenCalled();
  });

  it('marks successfully enqueued rows as Delivered', async () => {
    const job = makeJob();
    prisma.$queryRaw.mockResolvedValue([job]);

    await service.pollOutbox();

    expect(webhooksQueue.add).toHaveBeenCalledWith(
      job.event_type,
      expect.objectContaining({ foo: 'bar' }),
      { jobId: job.id },
    );
    expect(prisma.outboxEvent.updateMany).toHaveBeenCalledWith({
      where: { id: { in: [job.id] } },
      data: {
        processedAt: expect.any(Date) as Date,
        status: OutboxEventStatus.Delivered,
      },
    });
    // Failed batch update should be called with an empty id list.
    expect(prisma.outboxEvent.updateMany).toHaveBeenCalledWith({
      where: { id: { in: [] } },
      data: { status: OutboxEventStatus.Failed },
    });
  });

  it('routes GenerateReceipts events to the receipts queue and SendEmails to the emails queue', async () => {
    const receiptJob = makeJob({
      id: 'evt_receipt',
      event_type: EventType.GenerateReceipts,
    });
    const emailJob = makeJob({
      id: 'evt_email',
      event_type: EventType.SendEmails,
    });
    prisma.$queryRaw.mockResolvedValue([receiptJob, emailJob]);

    await service.pollOutbox();

    expect(receiptsQueue.add).toHaveBeenCalledWith(
      EventType.GenerateReceipts,
      expect.any(Object),
      { jobId: 'evt_receipt' },
    );
    expect(emailsQueue.add).toHaveBeenCalledWith(
      EventType.SendEmails,
      expect.any(Object),
      { jobId: 'evt_email' },
    );
  });

  it('leaves a row retriable (not Failed) when enqueue fails below OUTBOX_MAX_ATTEMPTS', async () => {
    const job = makeJob({ attempt_count: OUTBOX_MAX_ATTEMPTS - 3 });
    prisma.$queryRaw.mockResolvedValue([job]);
    webhooksQueue.add.mockRejectedValue(new Error('queue unavailable'));

    await service.pollOutbox();

    expect(prisma.outboxEvent.updateMany).toHaveBeenCalledWith({
      where: { id: { in: [] } },
      data: {
        processedAt: expect.any(Date) as Date,
        status: OutboxEventStatus.Delivered,
      },
    });
    expect(prisma.outboxEvent.updateMany).toHaveBeenCalledWith({
      where: { id: { in: [] } },
      data: { status: OutboxEventStatus.Failed },
    });
  });

  it('marks a row Failed once enqueue fails at/above OUTBOX_MAX_ATTEMPTS', async () => {
    const job = makeJob({ attempt_count: OUTBOX_MAX_ATTEMPTS - 1 });
    prisma.$queryRaw.mockResolvedValue([job]);
    webhooksQueue.add.mockRejectedValue(new Error('queue unavailable'));

    await service.pollOutbox();

    expect(prisma.outboxEvent.updateMany).toHaveBeenCalledWith({
      where: { id: { in: [job.id] } },
      data: { status: OutboxEventStatus.Failed },
    });
  });
});
