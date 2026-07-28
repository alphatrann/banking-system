# Banking System

A backend-focused banking system simulation designed to explore transactional integrity, asynchronous workflows, reliability patterns, and observability in distributed backend systems.

The project intentionally prioritizes backend engineering concepts over product completeness. It explores patterns commonly used in financial and event-driven systems such as transactional outbox, idempotent transaction processing, ledger-based accounting, retries with DLQs, and distributed tracing.

---

# Motivation

This project was built to gain hands-on experience with:

* Transactional outbox pattern
* Idempotent transaction processing
* Ledger-based accounting systems
* Background job processing
* Retries and dead-letter queues (DLQs)
* Database transaction isolation and row locking
* Async workflow orchestration
* Observability and distributed tracing
* Secure webhook delivery
* Encryption at rest
* Reverse proxies and containerized infrastructure

The architecture intentionally explores production-inspired backend reliability patterns rather than optimizing for MVP simplicity.

---

# Features

## Functional Requirements

* Register an account
* Authenticate with JWT-based login
* Transfer money between accounts
* View account balances
* Generate PDF transfer receipts
* Send email notifications after transfers
* Register and manage webhook endpoints
* Deliver signed webhook events asynchronously

## Non-Functional Requirements

### Data Integrity

* Account balances are derived from immutable ledger entries
* Concurrent transfers must never produce negative balances
* Transfers are idempotent and safe against duplicate requests
* Critical balance operations execute inside database transactions

### Performance

* User-facing transfer requests should complete under 1 second
* Non-critical workflows are offloaded asynchronously

### Reliability

* Failed jobs are retried with backoff
* Repeatedly failing jobs are moved into DLQs
* Outbox pattern prevents event loss between DB writes and queue publishing

### Security

* Webhook deliveries include signed payloads
* Webhook events include event IDs for idempotency checks
* Receipts and webhook secrets are encrypted at rest
* Transaction endpoints are rate limited

### Observability

* Every request includes distributed tracing metadata
* Important events are logged with structured logging
* Metrics and traces are exported for monitoring and analysis

---

# Key Engineering Decisions

The system's core design choices — ledger-based accounting, the transactional outbox pattern, async processing for non-critical workflows, PostgreSQL with serializable isolation, and Redis + BullMQ for job processing — are documented as Architecture Decision Records (ADRs), including the context, trade-offs, and alternatives considered for each. See the [ADR log](./docs/adr/README.md) for the full index.

* [ADR-0001: Ledger-Based Accounting](./docs/adr/0001-ledger-based-accounting.md)
* [ADR-0002: Transactional Outbox Pattern](./docs/adr/0002-transactional-outbox-pattern.md)
* [ADR-0003: Async Processing for Non-Critical Workflows](./docs/adr/0003-async-processing-for-non-critical-workflows.md)
* [ADR-0004: PostgreSQL with Serializable Isolation](./docs/adr/0004-postgresql-with-serializable-isolation.md)
* [ADR-0005: Redis and BullMQ for Job Processing](./docs/adr/0005-redis-and-bullmq-for-job-processing.md)

---

# Tech Stack

## Backend

* NodeJS
* NestJS

## Databases

* PostgreSQL
* Redis
* BullMQ

## Storage

* MinIO (S3-compatible object storage)

## Observability

* OpenTelemetry
* Prometheus
* Grafana
* Loki
* Jaeger

## Infrastructure

* Docker
* NGINX

---

# Project Structure

```txt
banking-system/
├── src/                      # NestJS source (5 processes built from this one tree — see ARCHITECTURE.md)
│   ├── main.api.ts            # API entrypoint — bootstraps AppModule (HTTP)
│   ├── main.outbox.ts         # Outbox worker entrypoint — standalone OutboxModule
│   ├── main.mail.ts           # Mail worker entrypoint — standalone MailSenderModule
│   ├── main.receipt.ts        # Receipt worker entrypoint — standalone ReceiptGeneratorModule
│   ├── main.webhooks.ts       # Webhook worker entrypoint — standalone WebhooksSenderModule
│   ├── app.module.ts          # API process root module
│   ├── telemetry.ts           # OpenTelemetry SDK bootstrap (tracing)
│   ├── metrics.ts             # OpenTelemetry metric instrument definitions
│   │
│   ├── auth/                  # JWT + local login, guards, register/login/me routes
│   ├── users/                 # Account CRUD/lookup (module name: accounts.module.ts → UsersModule)
│   ├── transactions/          # Transfer orchestration, ledger writes, idempotency keys
│   ├── webhooks/               # Webhook endpoint CRUD + registered-endpoint lookups (shared by 3 processes)
│   ├── webhooks-sender/        # Webhook delivery worker (BullMQ processor, signs + POSTs payloads)
│   ├── outbox/                 # Outbox poller — claims pending outbox rows, publishes to Redis queues
│   ├── mail/                   # MailerModule wrapper (SMTP transport + Handlebars templates), @Global()
│   ├── mail-sender/             # Email delivery worker (BullMQ processor)
│   ├── receipts/                # Receipt PDF/storage helpers shared by receipt-generator & mail-sender
│   ├── receipt-generator/       # Receipt generation worker — renders PDF, uploads to MinIO, re-enqueues via outbox
│   ├── minio/                   # MinIO/S3 client provider, @Global()
│   ├── queues/                  # BullMQ queue + DLQ registration, job option config
│   ├── prisma/                  # PrismaService/PrismaModule, DB error-code helpers
│   ├── metrics/                 # MetricsService (periodic gauges for queue depth etc.)
│   ├── logger/                  # Winston + Loki structured logging module, HTTP logging interceptor
│   ├── health/                  # Liveness/readiness endpoints (Terminus)
│   ├── guards/                  # Cross-cutting guards (e.g. per-user throttler)
│   ├── constants/                # Shared constants (e.g. base account amount, outbox retry limits)
│   └── utils/                    # ID generation, hashing, outbox job builders, formatters
│
├── prisma/
│   ├── schema.prisma           # Data model — see ARCHITECTURE.md for the generated ER diagram
│   └── migrations/             # SQL migration history
│
├── test/                      # Jest e2e specs
├── docs/
│   ├── API.md                 # HTTP route reference (this doc's sibling)
│   └── adr/                   # Architecture Decision Records
├── nginx/, grafana/, prometheus/, loki/, otel-collector/   # Provisioning/config for the observability + edge stack
├── nest-cli.*.json            # One Nest CLI build config per process (api/outbox/mail/receipt/webhooks)
├── compose.dev.yml / compose.prod.yml / compose.test.yml   # Docker Compose stacks per environment
├── ARCHITECTURE.md            # Deep-dive diagrams and design notes
└── README.md                  # You are here
```

---

# Architecture

See [ARCHITECTURE.md](./ARCHITECTURE.md) for diagrams (system architecture, transfer lifecycle, retry/DLQ
flow, observability flow, data model ER diagram, module boundaries, deployment topology) and a deep-dive on
request lifecycle, reliability, and security considerations.

For a route-by-route breakdown of the HTTP API, see [docs/API.md](./docs/API.md) (a live Swagger UI is also
available at `/api`).

---

# Observability

The project includes a full observability pipeline:

* OpenTelemetry for tracing and metrics
* Prometheus for metrics aggregation
* Grafana dashboards
* Loki log aggregation
* Jaeger trace visualization

This allows inspection of:

* request latency
* worker retries
* queue throughput
* transfer traces
* error rates

---

# Future Improvements

Potential future explorations include:

* Refresh token rotation
* More advanced rate limiting algorithms
* Chaos testing
* Horizontal scaling experiments
* Queue partitioning strategies
* Exactly-once event processing exploration
* Multi-region deployment experiments
* Webhook replay tooling
* Improved test coverage
* HTTPS + DNS configuration
* CI/CD pipelines

---

# Setup

## Prerequisites

* Docker
* NodeJS 22+ (development only)

Clone the repository:

```bash
git clone https://github.com/alphatrann/banking-system.git
```

---

# Production

Copy environment variables:

```bash
cp .env.example .env.production.local
```

Start production services:

```bash
docker compose -f compose.prod.yml up -d
```

API:

```txt
http://localhost
```

---

# Development

Install dependencies:

```bash
yarn
```

Copy environment variables:

```bash
cp .env.example .env.development.local
```

Start development infrastructure:

```bash
docker compose -f compose.dev.yml up -d
```

Apply database migrations:

```bash
yarn migrate:deploy:dev
```

Run services in separate terminals:

```bash
yarn start:dev:api
yarn start:dev:outbox
yarn start:dev:mail
yarn start:dev:receipt
yarn start:dev:webhooks
```

API:

```txt
http://localhost:5000
```

---

# Dashboards

## Development

* Swagger UI: `localhost:5000/api`
* Jaeger UI: `localhost:16686`
* Mailpit Inbox: `localhost:8025`
* Grafana: `localhost:3000`
* MinIO: `localhost:9001`

## Production

* Swagger UI: `localhost/api`
* Jaeger UI: `jaeger.localhost`
* Mailpit Inbox: `mail.localhost`
* Grafana: `grafana.localhost`
* MinIO: `minio.localhost`

## Grafana

Grafana is pre-provisioned as code — both the Loki and Prometheus datasources
(`grafana/provisioning/datasources/`) and a set of dashboards
(`grafana/provisioning/dashboards/`) are auto-loaded on `docker compose up`.
No manual setup is required; open Grafana and look under the
**Banking System** folder for:

* **Transfers & Ledger** — transfer request/failure rates, duration
  percentiles, money transferred, ledger entries, DB transaction duration and
  active transactions.
* **Outbox & Queues** — outbox events created/processed, enqueue failures,
  processing delay, pending events, and BullMQ job/queue/DLQ metrics.
* **Security** — auth failures and rate limit hits.

---

# Testing

Run E2E tests:

```bash
sh e2e.sh
```

---

# Important Notes

This project is a backend systems learning project and not a production-ready financial platform.

Some production concerns are intentionally simplified or omitted, including:

* advanced authentication flows
* regulatory compliance
* hardened infrastructure
* large-scale distributed deployment
* comprehensive security audits

The primary goal is to explore backend reliability and transactional systems design patterns in a realistic but approachable environment.

---

# License

MIT
