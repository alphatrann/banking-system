# ADR-0003: Async Processing for Non-Critical Workflows

## Status
Accepted

## Context
A single money transfer triggers several kinds of work with very different latency and reliability profiles:

* **Balance-critical work** — validating and locking the sender's balance, writing ledger entries, and recording the transaction — must be synchronous, strongly consistent, and fast, because the correctness of the account balance depends on it and the user is waiting on the HTTP response.
* **Non-critical side effects** — sending a confirmation email, generating a PDF receipt (which involves rendering + uploading to MinIO/S3), and delivering signed webhook payloads to third-party endpoints — are not required to complete before the API can return success, and some of them depend on slow, unreliable external systems (mail providers, arbitrary customer-controlled webhook URLs).

If these non-critical workflows were executed synchronously inside the transfer request, the API's latency and availability would be hostage to the slowest and least reliable dependency in that list — e.g. a webhook endpoint that times out would make `POST /transfers` itself slow or fail, even though the transfer itself succeeded and the money moved correctly. That directly conflicts with the project's non-functional requirement that transfer requests complete in under 1 second.

## Decision
Split transfer processing into two phases:

1. **Synchronous, in-request:** `TransactionsService.transferMoney` / `createTransaction` (`src/transactions/transactions.service.ts`) performs only balance-critical work inside a single serializable DB transaction — computing balances, writing `LedgerEntry` rows, creating the `Transaction` and `Receipt` placeholder rows, and writing outbox event rows describing the work still to be done (see ADR-0002). This is the only part of the flow the client waits on.
2. **Asynchronous, out-of-request:** the outbox worker (`src/outbox/outbox.service.ts`) enqueues jobs onto dedicated BullMQ queues, which are consumed by three independent worker processes, each its own deployable entry point (`yarn start:dev:mail`, `yarn start:dev:receipt`, `yarn start:dev:webhooks` — see `src/mail-sender/`, `src/receipt-generator/`, `src/webhooks-sender/`):
   * `mail-sender` — sends the transfer-completed/failed email.
   * `receipt-generator` — renders and uploads the PDF receipt to S3/MinIO.
   * `webhooks-sender` — delivers signed webhook payloads to registered customer endpoints.

Because these run as separate processes from the API, a slow mail provider or an unresponsive webhook endpoint only affects that worker's queue throughput, never the API's request/response latency.

## Consequences

**Positive**
* Transfer request latency is decoupled from the latency and reliability of external systems (mail provider, arbitrary webhook targets, PDF rendering). The API can meet its sub-1-second target regardless of how slow those systems are.
* Failure isolation: if the webhook target is down or the mail provider is rate-limiting, only that worker's queue backs up (and retries/DLQs per ADR on Redis+BullMQ) — the transfer itself is already durably committed and unaffected.
* Workers can be scaled, deployed, and restarted independently of the API and of each other.

**Negative**
* Eventual consistency for these side effects: a user may see their transfer succeed before their email/receipt/webhook has actually been delivered, and in failure cases (job exhausts retries into a DLQ) it may never be delivered without manual intervention/replay.
* More moving parts to operate: three additional long-running processes beyond the API and the outbox poller, each needing its own monitoring, logging, and deployment lifecycle (see the `compose.dev.yml`/`compose.prod.yml` service definitions and the observability stack).
* Debugging a transfer's full side-effect timeline now requires correlating across the API logs, the outbox table, and each worker's logs/traces (mitigated by the OpenTelemetry trace-context propagation carried through the outbox payload, but still more complex than a synchronous call stack).

## Alternatives Considered
* **Do everything synchronously inside the transfer request** (send email, generate receipt, deliver webhooks, then respond). Rejected because it makes the API's latency and success rate dependent on the slowest/least reliable external dependency in the chain, directly violating the project's sub-1-second latency goal and coupling unrelated failure domains together.
* **Fire-and-forget in-process async calls (e.g. calling `sendEmail()` without awaiting, inside the same Node process) instead of a queue-backed worker.** Rejected because it provides no retry, no durability across process restarts/crashes, and no backpressure — an in-flight email send is simply lost if the API process is killed before it completes.
