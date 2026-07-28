# ADR-0001: Ledger-Based Accounting

## Status
Accepted

## Context
The system needs to track account balances for a simulated banking product where correctness, auditability, and resistance to silent corruption matter more than raw read performance. The most obvious design — a mutable `balance` column on `Account` that is incremented/decremented in place — is simple and gives O(1) reads, but it has serious weaknesses for a financial system:

* It collapses history. Once a balance column is updated, the sequence of individual debits/credits that produced it is gone unless a separate audit-log is maintained in parallel (which then risks drifting out of sync with the "real" balance).
* It is easy to get wrong under concurrency. A `balance = balance - amount` update is only safe if every writer takes the same lock/isolation discipline; any code path that reads-then-writes without proper locking can silently lose updates.
* It provides no built-in self-consistency check. Corruption (a bad migration, a manual `UPDATE`, a bug) is invisible — there is no way to recompute the "true" balance from first principles and compare.

Ledger-based accounting (double-entry-inspired) avoids these problems by treating the balance as a *derived* value rather than a stored fact. Every transfer produces two immutable `LedgerEntry` rows (a debit and a credit, see `prisma/schema.prisma`), and the account balance at any point in time is defined as the sum of its ledger entries plus a starting amount. This mirrors how real financial ledgers work and gives the system an authoritative, replayable history of every balance change, not just its current value.

## Decision
Balances are never stored as a mutable field. Instead:

* Every transfer inserts two rows into `ledger_entries` (`LedgerEntry` in `prisma/schema.prisma`) inside the same database transaction that creates the `Transaction` record — one entry for the sender (negative `amount`) and one for the recipient (positive `amount`).
* Each `LedgerEntry` also stores a denormalized `runningBalance` (the account's balance immediately after that entry), computed at write time from the previously known balance.
* `LedgerService.computeBalance` (`src/transactions/ledger.service.ts`) resolves the current balance by first trying an O(1) lookup of the most recent ledger entry's `runningBalance`; only when an account has no ledger entries yet does it fall back to an aggregate `SUM(amount)` query plus `BASE_ACCOUNT_AMOUNT` (the newly-registered account's starting balance).
* `LedgerEntry` rows are never updated or deleted — they are append-only, which is what makes the running-balance cache trustworthy and the full history auditable.

## Consequences

**Positive**
* Full audit trail: every balance change is individually inspectable and attributable to a specific `Transaction`.
* Self-verifiable: the true balance can always be recomputed from `SUM(ledger_entries.amount)`, independent of the cached `runningBalance`, which is a built-in corruption check unavailable to a mutable-column design.
* Corruption-resistant: because entries are immutable and additive, there is no single field that a bad write can silently clobber without leaving a visible trace in the entry history.

**Negative**
* Balance reads are no longer a free column read. The common case is a cheap indexed lookup of the latest `runningBalance` (`ORDER BY id DESC LIMIT 1`), but that still costs an extra query per read compared to reading `account.balance` directly, and the fallback path (no entries yet) requires an aggregate `SUM` query.
* The `runningBalance` cache is only correct if every write path that creates ledger entries computes it consistently and under adequate isolation; a bug or bypass of `LedgerService.createLedgerEntries` (`src/transactions/ledger.service.ts`) could desynchronize the cache from the true summed balance. This is mitigated by isolation-level guarantees (see ADR-0004) but is a real risk surface that a mutable-column design with a single `UPDATE ... SET balance = balance - x` does not have.
* Amounts are stored as `BigInt` and explicitly range-checked (`toSafeNumber` in `ledger.service.ts`) before being converted to JS numbers, adding extra defensive code that a plain integer column would not require.

## Alternatives Considered
* **Mutable `balance` column on `Account`, updated via `UPDATE ... SET balance = balance ± amount` inside a transaction.** Rejected because it discards transaction history unless paired with a separate audit table (which then needs to be kept consistent with the balance itself — effectively reimplementing a ledger badly), and gives no way to independently verify that the stored balance is correct.
* **Mutable balance column + a parallel immutable audit-log table.** Rejected as strictly worse than a ledger: it carries the same corruption risk as the mutable column (the two tables can drift) while paying most of the storage/write cost of an actual ledger, without gaining the ledger's self-verifying property.
