# Architecture

This document is the deep-dive companion to [README.md](./README.md). It contains system diagrams, the data
model, module boundaries, deployment topology, and the detailed request/reliability/security notes that don't
belong in a first-read overview.

- [High-Level System Architecture](#high-level-system-architecture)
- [Transfer Lifecycle](#transfer-lifecycle)
- [Retry + DLQ Flow](#retry--dlq-flow)
- [Observability Flow](#observability-flow)
- [Data Model (ER Diagram)](#data-model-er-diagram)
- [Module Boundaries](#module-boundaries)
- [Deployment Topology (Production)](#deployment-topology-production)
- [Request Lifecycle](#request-lifecycle)
- [Reliability Considerations](#reliability-considerations)
- [Security Considerations](#security-considerations)

---

## High-Level System Architecture

```mermaid
flowchart LR
    %% Clients
    U[👥 Users]

    %% Edge
    NGINX["🟩 NGINX<br/>Reverse Proxy"]

    %% API Layer
    API["🟥 NestJS API"]

    %% Core Infra
    PG[(🐘 PostgreSQL)]
    REDIS[(🟥 Redis / BullMQ)]
    S3[(🟩 MinIO / S3)]

    %% Workers
    OUTBOX["🟥 Outbox Worker"]
    MAIL["📧 Email Worker"]
    WEBHOOK["🔔 Webhook Worker"]
    RECEIPT["🧾 Receipt Worker"]

    %% External
    EMAIL["✉️ Mail Provider"]

    %% Observability
    OTEL["📡 OpenTelemetry"]
    PROM["🔥 Prometheus"]
    GRAF["📊 Grafana"]
    LOKI["🪵 Loki"]
    JAEGER["🕸️ Jaeger"]

    %% Flow
    U --> NGINX --> API

    API --> PG
    API --> REDIS

    OUTBOX --> PG
    OUTBOX --> REDIS

    REDIS --> MAIL
    REDIS --> WEBHOOK
    REDIS --> RECEIPT

    RECEIPT --> S3
    MAIL --> S3

    MAIL --> EMAIL

    API -. telemetry .-> OTEL
    MAIL -. telemetry .-> OTEL
    WEBHOOK -. telemetry .-> OTEL
    RECEIPT -. telemetry .-> OTEL

    OTEL --> PROM
    OTEL --> JAEGER

    API -. logs .-> LOKI
    MAIL -. logs .-> LOKI
    WEBHOOK -. logs .-> LOKI
    RECEIPT -. logs .-> LOKI

    PROM --> GRAF
    LOKI --> GRAF

    %% Styling
    classDef api fill:#ffdddd,stroke:#cc0000,color:#000;
    classDef infra fill:#ddeeff,stroke:#0066cc,color:#000;
    classDef worker fill:#fff0cc,stroke:#cc8800,color:#000;
    classDef obs fill:#eee0ff,stroke:#7a3db8,color:#000;
    classDef storage fill:#ddffdd,stroke:#228822,color:#000;

    class API,OUTBOX,MAIL,WEBHOOK,RECEIPT api;
    class PG,REDIS,S3 storage;
    class OTEL,PROM,GRAF,LOKI,JAEGER obs;
    class NGINX infra;
```

---

## Transfer Lifecycle

> Updated to match the current implementation (`transactions.service.ts`, `ledger.service.ts`,
> `idempotency.service.ts`, `outbox.service.ts`, `receipt-generator.ts`). See
> [Discrepancies from the previous diagram](#discrepancies-from-the-previous-diagram) below for what changed.

```mermaid
sequenceDiagram
    autonumber

    actor User
    participant API as NestJS API
    participant DB as PostgreSQL
    participant OUTBOX as Outbox Table
    participant WORKER as Outbox Worker
    participant QUEUE as Redis Queue
    participant RECEIPT as Receipt Worker
    participant EMAIL as Email Worker
    participant WEBHOOK as Webhook Worker
    participant S3 as MinIO/S3

    User->>API: POST /transfer (X-Idempotency-Key)

    API->>DB: Create idempotency key (Processing)
    Note over API,DB: Duplicate key + same payload short-circuits<br/>with the stored response (idempotent replay)

    API->>DB: Begin Serializable transaction
    API->>DB: Compute sender/receiver balance<br/>from ledger entries
    API->>DB: Validate business rules<br/>(balance, same-account)

    alt Serialization conflict
        DB-->>API: 40001 serialization_failure
        API->>DB: Retry transaction (up to 3x)
    end

    API->>DB: Insert Transaction + 2 LedgerEntry rows
    API->>DB: Insert pending Receipt row
    API->>OUTBOX: Insert outbox events<br/>(receipt.generate, transfer.completed/failed webhooks)
    API->>DB: Mark idempotency key Completed
    API->>DB: Commit transaction

    API-->>User: 200/201 response (or NOT_FOUND / BAD_REQUEST / CONFLICT)

    WORKER->>OUTBOX: LISTEN/NOTIFY + poll unpublished events
    WORKER->>QUEUE: Enqueue jobs (receipts / webhooks / emails queues)

    QUEUE->>RECEIPT: receipt.generate job
    RECEIPT->>DB: Load transaction + ledger entries
    RECEIPT->>S3: Upload encrypted PDF receipt
    RECEIPT->>OUTBOX: Insert outbox events<br/>(send.email, receipt.generated webhooks)

    WORKER->>OUTBOX: Poll new events from Receipt Worker
    WORKER->>QUEUE: Enqueue email + webhook jobs

    QUEUE->>EMAIL: send.email job
    EMAIL->>S3: Fetch receipt PDF
    EMAIL-->>User: Send email with receipt attached

    QUEUE->>WEBHOOK: transfer.completed / transfer.failed / receipt.generated
    WEBHOOK-->>User: Send signed webhook to registered endpoint
```

### Discrepancies from the previous diagram

While updating this document the transaction/ledger/idempotency/outbox code was re-read to verify the old
README diagram still matched reality. It no longer did, in a few concrete ways:

1. **No explicit row lock.** The old diagram said "Lock sender account row." The current implementation does
   not take an explicit row lock — it runs the whole balance-check-and-write inside a Postgres
   `Serializable` transaction and retries on `40001 serialization_failure` (up to 3 attempts,
   `transactions.service.ts::createTransaction`). Concurrency safety comes from isolation level + retry, not
   `SELECT ... FOR UPDATE`.
2. **Idempotency key is written before the transfer transaction**, not implied as part of it. It's created
   `Processing` up front (unique constraint gives race protection), and completed inside the same
   transaction as the ledger writes on the happy path — or in a separate "finalize" pass only when the main
   transaction threw before a terminal result could be decided (`finalize()` fallback).
3. **Receipt generation is not just "upload PDF."** The receipt worker itself writes new outbox events
   (`send.email` per participant, `receipt.generated` webhook events) after the PDF is uploaded — it does not
   hand off directly to the email/webhook queues. Those new outbox rows are picked up by another poll cycle
   of the Outbox Worker before the email/webhook workers ever see them. The old diagram showed the outbox
   worker fanning out to all three workers in one pass and the email worker fetching the receipt directly
   after a single hop — that's no longer accurate.
4. **Outbox events carry OpenTelemetry trace context** (`traceContext` column) so spans in the async workers
   link back to the originating request's trace — not shown at all in the old diagram.
5. Failed transfers (insufficient balance, same-account, destination-not-found) also produce outbox-driven
   `transfer.failed` webhook events, written atomically with the rejection — this failure path wasn't
   represented previously.

---

## Retry + DLQ Flow

```mermaid
flowchart TD

    JOB["📦 Queue Job"]
    WORKER["🟥 Worker"]

    SUCCESS["✅ Success"]
    RETRY["🔁 Retry with Backoff"]
    DLQ["💀 Dead Letter Queue"]

    ALERT["🚨 Monitoring / Alerting"]

    JOB --> WORKER

    WORKER -->|Success| SUCCESS

    WORKER -->|Failure| RETRY

    RETRY -->|Retry limit exceeded| DLQ
    RETRY -->|Retry again| WORKER

    DLQ --> ALERT

    classDef success fill:#ddffdd,stroke:#228822,color:#000;
    classDef fail fill:#ffdddd,stroke:#cc0000,color:#000;
    classDef process fill:#ddeeff,stroke:#0066cc,color:#000;

    class SUCCESS success;
    class RETRY,DLQ fail;
    class JOB,WORKER,ALERT process;
```

---

## Observability Flow

```mermaid
flowchart LR

    API["🟥 API"]
    WORKERS["🟥 Workers"]

    OTEL["📡 OpenTelemetry"]
    LOKI["🪵 Loki"]

    PROM["🔥 Prometheus"]
    JAEGER["🕸️ Jaeger"]
    GRAF["📊 Grafana"]

    API -. traces .-> OTEL
    WORKERS -. traces .-> OTEL

    API -. logs .-> LOKI
    WORKERS -. logs .-> LOKI

    OTEL --> PROM
    OTEL --> JAEGER

    PROM --> GRAF
    LOKI --> GRAF

    classDef app fill:#ffdddd,stroke:#cc0000,color:#000;
    classDef obs fill:#eee0ff,stroke:#7a3db8,color:#000;

    class API,WORKERS app;
    class OTEL,LOKI,PROM,JAEGER,GRAF obs;
```

---

## Data Model (ER Diagram)

Generated directly from `prisma/schema.prisma`. Balances are never stored — `Account` balance is derived by
summing/reading the latest `LedgerEntry.runningBalance` for that account.

```mermaid
erDiagram
    Account ||--o{ LedgerEntry : "has"
    Account ||--o{ IdempotencyKey : "has"
    Account ||--o{ WebhookEndpoint : "owns"
    Account ||--o{ EmailEvent : "receives"

    Transaction ||--o{ LedgerEntry : "records"
    Transaction ||--o| Receipt : "has"

    WebhookEndpoint ||--o{ WebhookEvent : "receives"
    WebhookEvent ||--o{ WebhookAttempt : "has"

    File ||--o| Receipt : "backs"

    Account {
        string id PK
        string email UK
        string password
        datetime createdAt
    }

    Transaction {
        string id PK
        datetime initiatedAt
        datetime createdAt
    }

    LedgerEntry {
        int id PK
        string transactionId FK
        string accountId FK
        bigint amount
        bigint runningBalance
        datetime createdAt
    }

    OutboxEvent {
        string id PK
        string aggregateType
        string aggregateId
        string eventType
        json payload
        string status
        datetime nextRetryAt
        int attemptCount
        datetime createdAt
        datetime processedAt
        json traceContext
    }

    WebhookEndpoint {
        string id PK
        string accountId FK
        string url
        string encryptedSecret
        boolean active
        string_array subscribedEvents
        datetime deletedAt
        string iv
        string authTag
        int keyVersion
        string encryptionAlgorithm
        datetime createdAt
    }

    EmailEvent {
        string id PK
        string toAccountId FK
        json payload
        string status
        datetime failedAt
        string error
        datetime sentAt
        datetime createdAt
    }

    WebhookEvent {
        string id PK
        string endpointId FK
        string eventType
        json payload
        string status
        datetime createdAt
    }

    WebhookAttempt {
        string id PK
        string webhookEventId FK
        int responseStatus
        json responseBody
        string error
        int durationMs
        datetime createdAt
    }

    IdempotencyKey {
        string accountId PK,FK
        string key PK
        string requestHash
        string status
        int responseCode
        json responseBody
        datetime createdAt
    }

    File {
        string id PK
        string bucket
        string object
        bigint size
        string mimetype
        string iv
        string authTag
        int keyVersion
        string encryptionAlgorithm
        datetime createdAt
    }

    Receipt {
        string id PK
        bigint number UK
        string fileId FK
        string transactionId FK,UK
        string status
        datetime generatedAt
        datetime failedAt
        string error
        datetime createdAt
    }
```

Notes:

- `OutboxEvent` is intentionally not linked by foreign key to `Transaction`/`WebhookEndpoint` — `aggregateId`
  is a loosely-typed polymorphic reference (e.g. `"<transactionId>:<endpointId>"`), consistent with the
  outbox pattern decoupling producers from consumers.
- `LedgerEntry` has a `@@unique([transactionId, accountId])` constraint — each transaction can only post one
  entry per account (i.e. exactly the debit and the credit leg).
- `IdempotencyKey` has a composite primary key `(accountId, key)` rather than its own `id`.
- `Receipt.number` is a separate auto-incrementing sequence used as the human-facing receipt number, distinct
  from the ULID `id`.

---

## Module Boundaries

The codebase is a single NestJS source tree (`src/`) that is bootstrapped into **five separate processes**,
each with its own `nest-cli.*.json` build config and its own `main.*.ts` entrypoint. Only the API process
boots the shared `AppModule`; every worker process boots its **own standalone module** — they do not import
`AppModule` and do not share its HTTP/guard/throttler wiring.

| Process | Entrypoint | Nest CLI config | Root module |
|---|---|---|---|
| API | `src/main.api.ts` | `nest-cli.api.json` | `AppModule` |
| Outbox worker | `src/main.outbox.ts` | `nest-cli.outbox.json` | `OutboxModule` (standalone) |
| Mail sender worker | `src/main.mail.ts` | `nest-cli.mail.json` | `MailSenderModule` (standalone) |
| Receipt generator worker | `src/main.receipt.ts` | `nest-cli.receipt.json` | `ReceiptGeneratorModule` (standalone) |
| Webhooks sender worker | `src/main.webhooks.ts` | `nest-cli.webhooks.json` | `WebhooksSenderModule` (standalone) |

`AppModule` (API process) composes: `ConfigModule`, `UsersModule`, `PrismaModule`, `LoggerModule`,
`AuthModule`, `TransactionsModule`, `WebhooksModule`, `ThrottlerModule`, `MetricsModule`, `HealthModule`.

```mermaid
flowchart TB
    subgraph API_PROCESS["API process — main.api.ts → AppModule"]
        AppModule
        AuthModule
        UsersModule["UsersModule (accounts)"]
        TransactionsModule
        WebhooksModule
        HealthModule
        MetricsModule
        ThrottlerModule
    end

    subgraph OUTBOX_PROCESS["Outbox process — main.outbox.ts"]
        OutboxModule
    end

    subgraph MAIL_PROCESS["Mail process — main.mail.ts"]
        MailSenderModule
    end

    subgraph RECEIPT_PROCESS["Receipt process — main.receipt.ts"]
        ReceiptGeneratorModule
    end

    subgraph WEBHOOKS_PROCESS["Webhooks process — main.webhooks.ts"]
        WebhooksSenderModule
    end

    subgraph SHARED["Shared library modules (imported by multiple processes)"]
        PrismaModule
        LoggerModule
        QueuesModule["QueuesModule (BullMQ)"]
        MailModule["MailModule (@nestjs-modules/mailer)"]
        MinioModule
        ReceiptsModule
    end

    AppModule --> AuthModule
    AppModule --> UsersModule
    AppModule --> TransactionsModule
    AppModule --> WebhooksModule
    AppModule --> HealthModule
    AppModule --> MetricsModule
    AppModule --> ThrottlerModule
    AppModule --> PrismaModule
    AppModule --> LoggerModule

    AuthModule --> UsersModule
    TransactionsModule --> PrismaModule
    TransactionsModule --> WebhooksModule
    WebhooksModule --> PrismaModule
    UsersModule --> PrismaModule
    HealthModule --> PrismaModule
    MetricsModule --> PrismaModule
    MetricsModule --> QueuesModule

    OutboxModule --> QueuesModule
    OutboxModule --> PrismaModule
    OutboxModule --> LoggerModule

    MailSenderModule --> PrismaModule
    MailSenderModule --> LoggerModule
    MailSenderModule --> QueuesModule
    MailSenderModule --> ReceiptsModule
    MailSenderModule --> MailModule
    ReceiptsModule --> PrismaModule
    ReceiptsModule --> MinioModule

    ReceiptGeneratorModule --> PrismaModule
    ReceiptGeneratorModule --> QueuesModule
    ReceiptGeneratorModule --> MinioModule
    ReceiptGeneratorModule --> MailModule
    ReceiptGeneratorModule --> LoggerModule
    ReceiptGeneratorModule --> WebhooksModule
    ReceiptGeneratorModule --> ReceiptsModule

    WebhooksSenderModule --> WebhooksModule
    WebhooksSenderModule --> QueuesModule
    WebhooksSenderModule --> PrismaModule
    WebhooksSenderModule --> LoggerModule

    classDef process fill:#ddeeff,stroke:#0066cc,color:#000;
    classDef shared fill:#ddffdd,stroke:#228822,color:#000;
    class AppModule,OutboxModule,MailSenderModule,ReceiptGeneratorModule,WebhooksSenderModule process;
    class PrismaModule,LoggerModule,QueuesModule,MailModule,MinioModule,ReceiptsModule shared;
```

Notable cross-cutting facts:

- `WebhooksModule` is imported by three of the five processes (API, receipt generator, webhooks sender) —
  it's the shared home for `WebhooksService` (endpoint CRUD + lookup used to decide who to notify), while
  actual HTTP delivery lives in `webhooks-sender/webhooks-sender.ts` (the `Processor`).
- `MailModule` (the `@nestjs-modules/mailer` wrapper) is `@Global()` and consumed by both the mail sender and
  the receipt generator (the receipt generator also sends mail failure notifications).
- `MinioModule` is also `@Global()` — consumed by `ReceiptsModule` for object storage, in turn used by both
  the receipt generator and mail sender processes.
- Every worker process (`OutboxModule`, `MailSenderModule`, `ReceiptGeneratorModule`,
  `WebhooksSenderModule`) declares its own `ConfigModule.forRoot({ isGlobal: true, ... })` with its own Joi
  validation schema scoped to just the env vars that process needs — they do not inherit `AppModule`'s
  config validation.
- `MetricsModule` and `HealthModule` are API-process-only; workers currently expose metrics/health
  differently (or not at all) since they don't run an HTTP listener.

---

## Deployment Topology (Production)

Reflects `compose.prod.yml` exactly — service list and the real Docker network names/attachments
(`public-net`, `app-net`, `storage-net` (internal), `mail-net` (internal), `data-net` (internal), `obs-net`
(internal)).

```mermaid
flowchart TB
    subgraph public_net["public-net"]
        CLIENT[👥 Client]
    end

    subgraph proxy_box["proxy (nginx) — public-net, app-net, mail-net, obs-net, storage-net"]
        PROXY["proxy"]
    end

    subgraph app_net["app-net"]
        API1["api1"]
        API2["api2"]
        API3["api3"]
        MIGRATE["migrate (one-shot)"]
        WEBHOOKS_SENDER["webhooks-sender"]
    end

    subgraph data_net["data-net (internal)"]
        POSTGRES[("postgres")]
        REDIS[("redis")]
        OUTBOX["outbox"]
    end

    subgraph storage_net["storage-net (internal)"]
        MINIO[("minio")]
        RECEIPT_GEN["receipt-generator"]
    end

    subgraph mail_net["mail-net (internal)"]
        MAIL[("mail — mailpit")]
        MAIL_SENDER["mail-sender"]
    end

    subgraph obs_net["obs-net (internal)"]
        PROM["prometheus"]
        GRAFANA["grafana"]
        LOKI["loki"]
        JAEGER["jaeger"]
        OTEL_COLLECTOR["otel-collector"]
    end

    CLIENT -->|"80/443"| PROXY
    PROXY --> API1
    PROXY --> API2
    PROXY --> API3

    MIGRATE --> POSTGRES
    API1 --> POSTGRES
    API1 --> REDIS
    API1 --> MINIO
    API2 --> POSTGRES
    API2 --> REDIS
    API2 --> MINIO
    API3 --> POSTGRES
    API3 --> REDIS
    API3 --> MINIO

    OUTBOX --> POSTGRES
    OUTBOX --> REDIS

    MAIL_SENDER --> POSTGRES
    MAIL_SENDER --> REDIS
    MAIL_SENDER --> MAIL
    MAIL_SENDER --> MINIO

    RECEIPT_GEN --> POSTGRES
    RECEIPT_GEN --> REDIS
    RECEIPT_GEN --> MINIO

    WEBHOOKS_SENDER --> POSTGRES
    WEBHOOKS_SENDER --> REDIS

    API1 -.-> OTEL_COLLECTOR
    API2 -.-> OTEL_COLLECTOR
    API3 -.-> OTEL_COLLECTOR
    OUTBOX -.-> OTEL_COLLECTOR
    MAIL_SENDER -.-> OTEL_COLLECTOR
    RECEIPT_GEN -.-> OTEL_COLLECTOR
    WEBHOOKS_SENDER -.-> OTEL_COLLECTOR
    PROXY -.-> OTEL_COLLECTOR

    OTEL_COLLECTOR --> PROM
    OTEL_COLLECTOR --> JAEGER
    PROM --> GRAFANA
    LOKI --> GRAFANA
    JAEGER --> GRAFANA

    classDef edge fill:#ddeeff,stroke:#0066cc,color:#000;
    classDef app fill:#ffdddd,stroke:#cc0000,color:#000;
    classDef data fill:#ddffdd,stroke:#228822,color:#000;
    classDef obs fill:#eee0ff,stroke:#7a3db8,color:#000;

    class PROXY edge;
    class API1,API2,API3,MIGRATE,WEBHOOKS_SENDER,MAIL_SENDER,RECEIPT_GEN,OUTBOX app;
    class POSTGRES,REDIS,MINIO,MAIL data;
    class PROM,GRAFANA,LOKI,JAEGER,OTEL_COLLECTOR obs;
```

Notes verified against `compose.prod.yml`:

- `proxy` is the only service attached to `public-net`; it also joins `app-net`, `mail-net`, `obs-net`, and
  `storage-net` so it can reverse-proxy to internal dashboards (Grafana, Jaeger UI, Mailpit UI, MinIO
  console) as well as the API.
- `storage-net`, `mail-net`, `data-net`, and `obs-net` are all declared `internal: true` — only reachable
  from containers explicitly joined to them, not from the host or `public-net`.
- `api1`/`api2`/`api3` are 3 replicas of the same image behind `proxy`, each on `app-net` + `data-net` +
  `obs-net`. None of them are on `storage-net` or `mail-net` — MinIO/mail access for user-facing requests
  happens indirectly through the async workers, not the API itself directly serving files.
  (Note: `api*` services do connect to `minio` per their `depends_on`, but MinIO's `storage-net` isn't listed
  under `api1/2/3`'s `networks:` — this is a latent inconsistency in `compose.prod.yml` itself, called out
  here rather than silently "fixed" in the diagram, since diagrams here are meant to mirror the compose file.)
- `outbox`, `mail-sender`, `receipt-generator`, `webhooks-sender` are all one-replica worker processes;
  `mail-sender` is the only one attached to `mail-net`; `receipt-generator` and `mail-sender` are the only
  ones on `storage-net` (MinIO).
- `migrate` runs once (`service_completed_successfully` gate) before any API or worker container starts.

---

## Request Lifecycle

A typical money transfer follows this flow:

1. Client sends transfer request with `Authorization: Bearer <jwt>` and `X-Idempotency-Key`
2. API validates authentication (`JwtAuthGuard`) and rate limits (`ThrottlerModule` / `@Throttle`)
3. API checks/creates the idempotency key row (duplicate key + same payload short-circuits with the stored
   response; duplicate key + different payload is rejected)
4. A `Serializable` database transaction begins (retried up to 3x on serialization conflicts)
5. Ledger entries are inserted for both the sender and receiver
6. A `Transaction` record and pending `Receipt` row are created
7. Outbox events are inserted atomically (receipt generation + completed/failed webhook fan-out)
8. The idempotency key is marked `Completed` and the transaction commits
9. Outbox worker (`LISTEN/NOTIFY` + polling fallback) publishes async jobs to Redis/BullMQ queues
10. Workers process, in cascading stages:
    - receipt generation (PDF to MinIO, encrypted at rest)
    - a second outbox round trip for email delivery + `receipt.generated` webhooks
    - email delivery
    - webhook delivery (signed payloads)

This architecture separates:

- balance-critical synchronous operations (steps 1-8, target: sub-second)

from:

- non-critical eventual-consistency workflows (step 9-10, offloaded entirely to background workers)

---

## Reliability Considerations

### Idempotency

Transfers require an `X-Idempotency-Key` header. The key + a hash of the request body are stored per
account (`IdempotencyKey`, composite PK `(accountId, key)`); a retried/duplicate request with the same key
and body replays the original stored response instead of re-executing the transfer. Reusing a key with a
different payload is rejected with `400`; a concurrent duplicate still mid-flight is rejected with `409`.

### Concurrency Control

Balance-affecting transactions run at Postgres `Serializable` isolation and are retried (up to 3 attempts)
on `40001 serialization_failure`, rather than relying on explicit row locks. This prevents lost updates and
negative balances under concurrent transfers against the same account.

### Retries and DLQs

BullMQ workers retry failed jobs with backoff. Jobs exceeding retry limits are moved into dedicated DLQ
queues (e.g. `ReceiptsDLQ`) for inspection and replay, and the failure is recorded on the originating
domain row (e.g. `Receipt.status = Failed`) so it's queryable without digging through queue state.

### Failure Isolation

External integrations — email providers, webhook targets, PDF generation/object storage — are isolated
behind async workers so a slow or failing dependency never blocks the synchronous transfer path.

### Outbox Delivery Guarantee

Outbox events are only ever inserted inside the same DB transaction as the domain writes they describe, so
a committed transfer can never "lose" its downstream side effects to a crashed process between the DB write
and the queue publish. The outbox worker uses `SELECT ... FOR UPDATE SKIP LOCKED` when claiming a batch, so
multiple outbox worker instances (if scaled out) can't double-process the same event.

---

## Security Considerations

- Signed webhook payloads, verified via a per-endpoint secret
- Webhook secrets and receipt files are encrypted at rest (AES, versioned key + IV/auth tag stored alongside
  the ciphertext in `webhook_endpoints` / `files`)
- JWT authentication (`JwtAuthGuard`), 30-minute token expiry
- Rate limiting via `ThrottlerModule`, both a global default and per-route `@Throttle` overrides (see
  [docs/API.md](./docs/API.md))
- Request tracing (OpenTelemetry) and structured audit logging (Winston + Loki), including trace/span IDs
  attached to log lines
- Webhook events carry event IDs for idempotency checks on the receiving end

This is not intended to be a production-ready banking platform. The project focuses primarily on backend
systems learning and reliability exploration.
