# Architecture Decision Records

This is a log of the architectural decisions made for this project. Each ADR captures a decision, the context that led to it, and the trade-offs accepted.

| ADR | Title | Summary |
|-----|-------|---------|
| [ADR-0001](./0001-ledger-based-accounting.md) | Ledger-Based Accounting | Account balances are derived from immutable ledger entries rather than a mutable balance column, for auditability and corruption resistance. |
| [ADR-0002](./0002-transactional-outbox-pattern.md) | Transactional Outbox Pattern | Transfer-related events are written to an outbox table in the same DB transaction as ledger updates, then relayed to queues by a separate poller, avoiding lost events between DB commit and queue publish. |
| [ADR-0003](./0003-async-processing-for-non-critical-workflows.md) | Async Processing for Non-Critical Workflows | Only balance-critical work happens synchronously in the transfer request; email, receipt generation, and webhook delivery run in separate async worker processes. |
| [ADR-0004](./0004-postgresql-with-serializable-isolation.md) | PostgreSQL with Serializable Isolation | Transfers run inside Postgres `SERIALIZABLE` transactions with bounded retry on serialization failures, to guarantee correctness under concurrent transfers. |
| [ADR-0005](./0005-redis-and-bullmq-for-job-processing.md) | Redis and BullMQ for Job Processing | Redis + BullMQ back the async job queues for a lightweight operational footprint, accepting weaker delivery/ordering guarantees than Kafka/RabbitMQ in exchange. |

## Status Legend
* **Accepted** — currently in effect.
* **Superseded** — replaced by a later ADR (the newer ADR is linked in the entry).
* **Deprecated** — no longer applicable, no replacement.
