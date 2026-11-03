# Durable runtime storage foundation

P0-A implements the internal persistence and command layer of the
[durable task design](superpowers/specs/2026-11-03-durable-task-runtime-design.md).
It does not start an agent, call a model, execute tools, open a daemon socket,
or automatically resume interrupted work. The existing CLI and session runtime
continue to use their existing lifecycle.

## Implemented boundaries

`src/services/runtime/` contains:

| Module | Responsibility |
| --- | --- |
| `types.ts` | Run/task/attempt identities, wait conditions, effects and allowed task transitions |
| `json.ts` | Bounded canonical JSON and command digests |
| `schema.ts` | Version 1 SQLite schema, foreign keys and unique active-attempt constraints |
| `store.ts` | FULL synchronous persistence, transactions, queries, receipts, events and leased outbox rows |
| `commands.ts` | Graph creation, attempt reservation/results, signals, waits and Run control requests |

The caller supplies a local database path. Database files are private, use WAL,
and reject unknown or newer schemas. A successful command commits its receipt,
business state, events and effects together. Same command ID and canonical input
return the original receipt, including after reopening the database; a status
query is needed for the current state. Reusing an ID with different input fails.
Failed commands leave no receipt. Transactions are synchronous; their mutation
handles expire when the callback returns, preventing delayed writes escaping a
rolled-back transaction.

Task input identity cannot change through a state transition. State writes use
expected revisions; attempts also carry an owner, epoch and expiry. P0-A admits
at most one active business attempt per Run regardless of the saved future
collaboration preference. It does not grant delegation or implement scheduling.
`finishAttempt` can submit a candidate for validation, but cannot declare it
verified or mark the task successful. Checkpoint and candidate references are
metadata until the artifact and validation layer is implemented.

## Waiting and control

Signals have durable per-Run, per-kind/key generations. Registering a wait checks
the already committed generation in the same transaction. Posting a signal
checks registered waits in that transaction. An explicit `scanWaiting` command
can recover a missed notification after reopening; ordinary queries never
change task state. Timers and approval authorization are not driven by this
storage layer: their future adapters must validate the underlying condition
before posting its signal.

Pause immediately blocks new attempt admission. With an active attempt it is
`pausing` until the attempt reports a checkpoint; a completed checkpoint can
preserve the next wait/validation state for an explicit resume. Cancellation
persists `cancelling` and never claims cleanup is complete. Late candidate
results after cancellation retain their evidence and enter `reconciling`.
No API here turns an expired running attempt into a new attempt automatically.

## Queue behavior

Outbox rows coalesce by Run/kind/key, preserve FIFO sequence, and increment a
generation on replacement. Claims have independent tokens and expiries. A late
acknowledgement cannot delete a newer claim. If a claimed row was updated, its
completion releases the old lease but preserves the replacement without applying
the old retry delay. Stale consumers must still revalidate task revision and
authority before performing effects when an executor is added.

Default limits are 256 business effects globally, 64 per Run and 64 nonterminal
Runs. Each admitted Run has one separate, coalesced control position, so a full
business queue cannot prevent pause/cancel requests. Paused and cancelling Runs
do not yield business effects; control effects remain claimable. Claims and
acknowledgements are storage primitives, not external-effect exactly-once
guarantees. Retry scheduling, fairness, cleanup and evidence retention are
responsibilities of subsequent slices.

## Recovery validation

Unit and local subprocess tests cover receipt replay, graph/queue rollback,
revision and owner conflicts, both wait/signal orderings, missed notifications,
pause/cancel persistence, outbox generation and lease races, and schema refusal.
Subprocess tests issue SIGKILL inside an uncommitted transaction and after a
committed command, then reopen the same database. A separate two-process test
proves only one attempt reservation is accepted and event sequences stay unique.

These checks prove storage boundaries. They do not yet prove tool-effect,
hierarchical Agent, transcript, worktree or cross-workspace recovery. Next is
P0-B: stable journal identities, effect outcome records and transcript delivery
deduplication. Production worker dispatch remains gated on the remaining P0
implementation and macOS fault tests.
