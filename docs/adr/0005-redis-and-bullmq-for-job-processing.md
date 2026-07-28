# ADR-0005: Redis and BullMQ for Job Processing

## Status
Accepted

## Context
The async workers described in ADR-0003 (email, receipt generation, webhook delivery) need a job queue to consume from, fed by the outbox poller (ADR-0002). The queueing technology needs to support at minimum: reliable job delivery to a worker, configurable retry with backoff, and a dead-letter path for jobs that exhaust their retries (per the project's reliability requirements). It also needs to be operable comfortably within a single-host/small Docker Compose setup, since this is a learning project rather than a production deployment targeting high throughput or strict ordering guarantees at scale.

The realistic options in the Node/NestJS ecosystem are a Redis-backed queue library (BullMQ), or a dedicated message broker/streaming platform such as RabbitMQ or Kafka.

## Decision
Use Redis as the queue backing store with BullMQ as the queue library. `QueuesModule` (`src/queues/queues.module.ts`) registers one BullMQ queue per `QueueName` (webhooks, emails, receipts) plus a corresponding DLQ queue per `DLQName`, all connected to a single shared Redis instance (`CACHE_URL`). Each queue is configured with `removeOnComplete: { age: 3600 }` (retain completed jobs for an hour, useful for debugging/observability) and `removeOnFail: false` (failed jobs are preserved rather than deleted, so they can be inspected or moved to a DLQ instead of silently disappearing). Per-queue job options (retry counts/backoff) come from `getQueueJobOptions(name)`.

Workers for each queue run as separate Node processes (`src/mail-sender/`, `src/receipt-generator/`, `src/webhooks-sender/`), consuming jobs concurrently and independently of the API process.

## Consequences

**Positive**
* Minimal operational footprint: Redis is a single, well-understood piece of infrastructure to run (already needed for other purposes in many Node stacks), versus standing up and operating a dedicated broker cluster.
* BullMQ integrates directly with NestJS (`@nestjs/bullmq`) and gives retry-with-backoff, delayed jobs, and DLQ-style workflows out of the box, which map directly onto the project's stated reliability goals without custom plumbing.
* Fast to iterate with locally (single Redis container in `compose.dev.yml`), consistent with the project's learning-focused, approachable-environment goal.

**Negative**
* Weaker delivery and ordering guarantees than a dedicated broker: Redis-backed queues do not offer the same durability/replication guarantees as Kafka's replicated log or RabbitMQ's broker-level acknowledgment and clustering model. This is an accepted tradeoff given the project isn't targeting high-throughput distributed streaming.
* No built-in consumer-group/partition model for horizontal scaling with ordering guarantees the way Kafka provides — scaling workers here just means more consumers pulling from the same Redis-backed queue, which is simpler but less powerful.
* Redis becomes a single point of failure for all async workflows (webhooks, email, receipts) unless separately clustered/replicated, which this project does not do.

## Alternatives Considered
* **Kafka.** Rejected: Kafka is built for high-throughput, ordered, replayable event streaming at scale — capabilities this project doesn't need and that would add substantial operational complexity (ZooKeeper/KRaft, partition management, broker clustering) disproportionate to the learning goals, which are about reliability patterns (retries, DLQs, outbox) rather than streaming infrastructure.
* **RabbitMQ.** Rejected for similar reasons: a dedicated AMQP broker offers stronger delivery guarantees and routing flexibility than Redis/BullMQ, but introduces another infrastructure component to run, configure, and monitor, without adding much over BullMQ for this project's actual queue usage patterns (a handful of well-defined job types, no complex routing topology).
