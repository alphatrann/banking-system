# ADR-0002: Transactional Outbox Pattern

## Status
Accepted

## Context
When a transfer completes, several side effects need to happen: send a confirmation email, generate a PDF receipt, and deliver webhook notifications to any endpoints the account owner registered. These side effects are naturally asynchronous — they should not block the user-facing transfer response, and they are handled by separate worker processes (`src/mail-sender/`, `src/receipt-generator/`, `src/webhooks-sender/`) that consume jobs from Redis/BullMQ queues (see ADR-0003 and ADR-0005).

The problem is how to get a job onto a queue *reliably* once the database transaction that decided a transfer succeeded (or failed in a way that needs a `TransferFailed` notification). If the API handler committed the database transaction and then, as a separate step, called `queue.add(...)` directly, there is an unavoidable gap between "the transfer is durably recorded" and "the job is enqueued":

* If the process crashes or the queue call fails after the DB commit, the transfer succeeded but no email/webhook/receipt job is ever created — a silent, unrecoverable loss of a side effect for a financial event.
* Conversely, publishing to the queue *before* committing the DB transaction risks the opposite failure: a worker could pick up and act on a job for a transfer that then gets rolled back.

Because a single Postgres transaction and a separate Redis `queue.add()` call cannot be committed atomically as one operation (there is no distributed 2PC across the two systems in this architecture), some mechanism is needed to guarantee that "the transfer was recorded" and "a job describing it will eventually be enqueued" either both happen or neither happens.

## Decision
Use the transactional outbox pattern:

* When `TransactionsService.decideTransfer` (and the failure path, `writeFailureOutbox`, in `src/transactions/transactions.service.ts`) processes a transfer, it writes rows into the `outbox_events` table (`OutboxEvent` model in `prisma/schema.prisma`) using the *same* Prisma `$transaction` that inserts the `LedgerEntry` rows and the `Transaction` record. Because it's the same DB transaction, the outbox rows and the ledger writes are atomic — either both are committed or both are rolled back. See `insertOutbox` in `transactions.service.ts`, which also issues a `NOTIFY outbox_channel` after the insert as a low-latency wakeup hint for the poller.
* A separate outbox worker process (`OutboxService.pollOutbox` in `src/outbox/outbox.service.ts`) polls the `outbox_events` table independently of the request/response cycle. It claims a batch of pending/retry-eligible rows using `UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED LIMIT 50)`, which lets multiple outbox worker instances run concurrently without double-claiming the same row.
* For each claimed event, the poller calls the appropriate BullMQ queue's `.add(...)` (webhooks, emails, or receipts queue) using the outbox event's own `id` as the BullMQ `jobId`, which makes the enqueue step idempotent — retried polls for the same event will not create duplicate jobs.
* Successfully enqueued events are marked `Delivered`; events that exhaust `OUTBOX_MAX_ATTEMPTS` are marked `Failed` (see `OUTBOX_MAX_ATTEMPTS` in `src/constants.ts` and the retry/backoff logic embedded in the `pollOutbox` claim query's `next_retry_at` computation, which uses exponential backoff with jitter capped at 600 seconds).

## Consequences

**Positive**
* Eliminates the "DB committed but queue publish lost" failure mode entirely — the outbox row is proof, durably stored in the same transaction, that the event needs to be published, and the poller will keep retrying until it succeeds or exhausts its attempt budget.
* The BullMQ `jobId = outboxEvent.id` scheme makes enqueue-side retries idempotent, so a poller crash mid-batch cannot double-enqueue a job.
* Poller crashes or restarts are safe: `FOR UPDATE SKIP LOCKED` means an in-flight claim by a dead worker will eventually become eligible again via `next_retry_at`, without another worker blocking on it.

**Negative**
* Added operational complexity: there is now an extra table (`outbox_events`), an extra long-running poller process, and an extra hop (poll → enqueue) between "transfer committed" and "job actually running on a worker," compared to publishing directly to the queue from the request handler.
* Latency: events are not enqueued the instant the transaction commits; they wait for the next poll cycle (mitigated by the `NOTIFY outbox_channel` hint, but the polling/locking machinery itself still adds overhead versus a direct publish).
* The outbox table needs its own lifecycle management (the `Delivered`/`Failed` status, `attempt_count`, `next_retry_at` columns) that a direct-publish design would not need at all.

## Alternatives Considered
* **Publish directly to the Redis/BullMQ queue from within the request handler, right after (or as part of) the DB transaction.** Rejected because it reintroduces the atomicity gap described above — a crash or transient Redis failure between the DB commit and the queue call permanently loses the event, with no record that it was ever supposed to happen.
* **Two-phase commit across Postgres and Redis.** Not pursued: BullMQ/Redis has no 2PC participant support, and even if it did, 2PC across heterogeneous systems adds significant complexity and failure modes of its own for a learning project whose goal is to explore the outbox pattern specifically.
