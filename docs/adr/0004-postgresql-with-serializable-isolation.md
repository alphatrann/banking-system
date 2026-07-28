# ADR-0004: PostgreSQL with Serializable Isolation

## Status
Accepted

## Context
Concurrent transfers against the same account are the central correctness hazard in a banking system: two simultaneous transfers debiting the same sender must never both succeed if their combined amount exceeds the balance, and the derived ledger balance (see ADR-0001) must never be computed from a stale or partially-written view of the account's ledger entries. This requires strong transactional guarantees from the datastore, not just "eventual" consistency.

PostgreSQL was chosen as the primary datastore specifically because it provides full ACID transactions, configurable isolation levels up to `SERIALIZABLE`, and row-level locking primitives (`FOR UPDATE SKIP LOCKED`, used by the outbox poller — see ADR-0002) — all needed to implement both the transfer-correctness guarantees and the outbox claiming mechanism without bolting on an external coordination service.

For the transfer path specifically, the system needs to prevent classic race conditions such as: two concurrent transfers both reading the sender's balance as sufficient before either has committed, then both committing debits that together overdraw the account. Read-committed or repeatable-read isolation would not, by themselves, prevent every such anomaly (a genuinely serializable execution order is being relied upon).

## Decision
Every transfer runs inside a single Prisma `$transaction` executed at `Prisma.TransactionIsolationLevel.Serializable` (`TransactionsService.createTransaction` in `src/transactions/transactions.service.ts`). Inside that transaction, the code reads the sender's current balance (`LedgerService.computeBalance`), decides whether the transfer is valid, and writes the resulting ledger entries — all as one atomic, serializable unit of work.

Postgres enforces true serializable isolation using Serializable Snapshot Isolation (SSI), which detects would-be serialization anomalies at commit time and aborts one of the conflicting transactions with a `40001` (serialization_failure) error rather than silently allowing an inconsistent interleaving. Because aborts under `SERIALIZABLE` are an expected, routine outcome under contention (not an exceptional error condition), the code treats them as retryable:

* `createTransaction` wraps the `$transaction` call in a loop bounded by `MAX_SERIALIZATION_RETRIES = 3`.
* `isSerializationFailure(error)` (`src/prisma/error-codes.ts`) recognizes Postgres's `40001` code.
* On a serialization failure with retries remaining, the loop simply re-runs the entire transaction from scratch (re-reading balances, re-deciding the transfer) rather than surfacing the error to the client; metrics (`transferFailuresTotal` with `reason: 'serialization_failure'`) record each retry for observability.
* If retries are exhausted, the request fails with a 500-level response rather than retrying indefinitely, bounding worst-case request latency.

## Consequences

**Positive**
* Correctness under concurrency is delegated to Postgres's SSI implementation rather than hand-rolled application-level locking, which is easy to get subtly wrong (e.g. forgetting to lock a row, or locking in an order that still permits an anomaly).
* Combined with the ledger design (ADR-0001), this guarantees that a committed transfer always reflects an internally consistent, serializable view of both accounts' balances at the moment of decision.

**Negative**
* Serializable isolation carries a real throughput cost under contention: concurrent transfers touching the same account(s) will experience aborts and retries rather than blocking-and-proceeding, and the codebase has to explicitly implement bounded retry logic (`MAX_SERIALIZATION_RETRIES` in `transactions.service.ts`) to paper over this — a repeat-committed or optimistic-locking design would surface a similar but differently-shaped retry burden.
* A transfer under heavy contention can be retried up to 3 times, meaning worst-case latency for a single request is a multiple of a normal transaction's latency, and the final attempt can still fail outright (returned as an internal error), which is a user-visible cost the code accepts as a tradeoff for correctness.
* Requires careful handling in application code to distinguish "genuine business failure" (e.g. insufficient balance — a valid, non-retryable outcome) from "infrastructure-level serialization conflict" (retryable) — visible in how `decideTransfer`'s business-rule failures are treated differently from the `isSerializationFailure` catch branch in `createTransaction`.

## Alternatives Considered
* **Optimistic locking / version column on `Account`** (read balance + version, write with `WHERE version = ?`, retry on version mismatch). Rejected in favor of relying on Postgres's built-in `SERIALIZABLE` isolation: a version-column scheme only protects the single row it's attached to and would need to be manually extended to cover multi-row invariants (e.g. both the sender and recipient ledger inserts, plus the outbox writes, all being part of the same consistent decision) — Serializable isolation covers the whole transaction's read/write set automatically.
* **Application-level row locking via explicit `SELECT ... FOR UPDATE`** at a lower isolation level (e.g. Read Committed). Rejected as more error-prone: it requires the developer to correctly identify and lock every row involved in an invariant, in a consistent order, everywhere in the codebase that touches those rows — a single missed lock reintroduces the race. `SERIALIZABLE` isolation is a systemic guarantee rather than a per-call-site discipline.
* **Weaker isolation (Read Committed, the Postgres default) with balance checks re-validated at write time.** Rejected because it does not fully rule out write-skew-style anomalies across the two ledger entries and the balance check; it would require significant additional application logic to reach the same correctness guarantee that `SERIALIZABLE` provides natively.
