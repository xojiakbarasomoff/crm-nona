# AC10 intermittent failure — root cause and fix (2026-10-24)

**Symptom.** `amo-sync.test.ts › AC10` (100 parallel leads, 10 concurrent processors) occasionally failed in full-suite runs on a busy machine.

**Reproduction.** 10 CPU-burning processes in parallel, AC10 run 3×: 1 failure. With the new diagnostic assertion the stored inbox errors were:
`Transaction API error: A query cannot be executed on an expired transaction. The timeout for this transaction was 5000 ms, however 8373 ms passed …` at `assignment.service.ts` (`managerPoolMember.findMany`).

**Root cause.** Round-robin takes `SELECT … FOR UPDATE` on the manager-pool row inside the intake transaction, and the lock was held until commit — while identity resolution, lead insert, events, audit, outbox and notifications were still being written. Under contention the queued transactions waited longer than Prisma's 5 s interactive-transaction limit and expired. Inbox rows went to `failed` and were retried later (no data loss, but delayed assignment and a failing assertion).

**Fix.**
1. Assignment is the last step before commit (`LeadsService.createLead({ deferAssignment })` + `assignLead`, `IntakeService.finishAssignments`): the pool lock now covers only the assignment and the writes for that one lead. Atomicity is unchanged (same transaction).
2. Intake transactions: `timeout 20 s`, `maxWait 10 s`, and `SET LOCAL lock_timeout = '15s'` so an abnormal lock wait fails cleanly and is retried by the inbox instead of hanging.
3. AC10 asserts that no inbox row failed (with the stored error) and has an explicit 180 s budget as a stress test.

**Verification.** Same CPU load, AC10 run 5×: 5 passed, 0 expired transactions. Full integration suite 86/86.
