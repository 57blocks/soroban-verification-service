# Test suites own the rows they create, and the shared Postgres is not reset between them

> **Status**: Accepted 2026-08-12 (teki) · promoted from `Proposed` under the standing ruling that a `Proposed` status on shipped scope is a status nobody wrote back, and the state of the code decides it
> **Scope**: how the four services' Jest suites are isolated from each other and from previous runs
> on the one local/CI Postgres. Changes no production request behaviour; production teardown now
> closes the Prisma pool owned by `DbModule`.

## Context

> Written against `main` at `1bd96a3`. #63, #65 and #67 landed while this was open and reached the
> same root cause independently; `main` already carries a fix for the 429 and per-suite job cleanup.
> This ADR is what those changes did not settle: which mechanism the repo standardises on, and why.
> The merge's choices, side by side, are in
> `../features/test-isolation/notes.md`.

`pnpm run test` runs the services' suites through Turborepo at default concurrency, and Jest runs
each service's spec files across parallel workers. All of them talk to **one** Postgres — one
container locally, one service container in CI. Suites were interfering, and the failures looked
exactly like product bugs.

The measured mechanism was not row collision. It was a **counter keyed by client identity and the
wall clock**.

`AbuseGuardService` keys its sliding window on `(sha256(req.ip), floor(now / windowMs) * windowMs)`
and persists it via `AbuseControlRepository`. Under supertest every request from every spec file,
every service and every past run arrives from `127.0.0.1`, so they all share **one row per
wall-clock minute**, and nothing ever deletes it. `SCVS_ABUSE_MAX_PER_WINDOW` defaults to 30.

verification-svc's suite makes 17 guarded requests. One run against a clear counter passes 44/44; a
second run inside the same 60-second bucket takes the row to 34, and every request past the 30th
answers **429** where the spec asserts 202. Two consecutive runs, measured: 44/44, then 41/44. On a
database used for dozens of runs it presents as a permanent 13/44, which is what made it read as a
regression rather than as harness state.

The dedup path — the intuitive suspect — is not involved. `getActiveJobForTarget` filters on
network, status, `updatedSince` and an `OR` over contract_id/wasm_hash, with `targetOrFilters`
dropping absent fields so Prisma never sees an `undefined` that would match every row; and the
fixtures randomize `contract_id` per call. With the quota raised, the suite passes 44/44 against a
database holding 337 foreign job rows.

## Decision

**1. A suite deletes the rows it created, and only those.** Ids are tracked as they are created
(`@scvs/db/testing`'s `CreatedRows`) and removed in `afterAll`, through
`JobsRepository.deleteJobs`. Rebuilds that orchestrator-svc creates mid-run are read back off the
tracked jobs, and dropped only when no other job still references them — one rebuild legitimately
serves several jobs (ADR-008).

One shared tracker rather than an id array per suite, which is what #67 introduced: the arrays were
the same six lines six times, and every one of them deleted jobs only, so rebuilds went on
accumulating. "Only what it created" also rules out a table-wide sweep of a table nobody owns —
#67's `DELETE FROM abuse_control` is the shape this forbids, however harmless the rows.

**2. Isolation is by ownership, not by giving each suite its own database or schema.** A suite may
read the whole table; it may not write or delete outside what it owns.

**3. A production quota that a test harness is bound to exceed is test-environment configuration.**
`SCVS_ABUSE_MAX_PER_WINDOW` is raised in verification-svc's `jest.setup.cjs`, alongside
`SCVS_DRAIN_GRACE_MS = 0`, which is there for the same reason: at its production value it makes the
suite measure the clock instead of the code. The guard's own threshold behaviour is now covered
directly by `abuse-guard.spec.ts`, which invents a per-test client address *and* pins the instant
each case runs at, so its counter can collide with neither another suite nor a window boundary.

Pinning the instant is what `checkAbuse`'s new defaulted `now` parameter is for. `currentWindowStart`
already accepted one and no caller ever passed it; threading it up one level is the difference
between asserting the rollover and racing it. No production caller passes it, so behaviour is
unchanged — and the alternative, a test-only kill switch on an abuse control, would be a far worse
thing to add to a security surface.

**4. The database's state is reported, not assumed.** A Jest `globalSetup` on the two writing
services prints what was already in the database before the suites started. Two exclusions, both
because a warning that fires on a green run is one nobody reads: `abuse_control`, which the guard
writes on every request and nothing deletes; and any end-of-run "this run leaked N rows" report,
since `pnpm run test` runs the services in parallel and a whole-table delta then counts a sibling's
in-flight rows — measured at `jobs+10 rebuilds+9` on a run that ended with the database empty. A leak
still surfaces, as a dirty database on the next run.

**5. Test clients use one pooled Postgres connection each and close it through their owner.** Jest
workers and Turborepo services overlap, so node-postgres's default ten-connection pool per Nest app
can exceed the local/CI server's 100-connection limit even when every suite owns its rows correctly.
`createPrismaClient()` sets the adapter pool maximum to one only under `NODE_ENV=test`; production
keeps the driver default, and `readDbEnv()`'s configuration shape remains unchanged. `DbModule`
disconnects the client it creates on module shutdown, and a suite that creates a Nest app or
`TestingModule` closes it in `afterAll`.

**6. A route test does not start resident workers unrelated to the route.** In particular, the
orchestrator health test compiles the real `AppModule` but overrides the SQS consumer and recovery/
scheduler providers before `app.init()`. Starting those providers in a health-route suite would let
them scan and mutate jobs owned by another concurrent suite, directly violating decision 1.

**7. Database-backed service suites run serially inside their service process.** Turborepo still runs
the services concurrently, but orchestrator-svc and query-svc use Jest's `--runInBand`. Their suites
share one database and spend most of their time waiting on it; extra Jest workers add connection and
shutdown contention without providing useful isolation. Serial service-local execution also avoids
Jest force-terminating workers whose Prisma/Nest teardown finishes outside its short worker-exit
window under a saturated full-workspace run.

## Alternatives considered

**A database or schema per Jest worker.** The obvious answer, and it does not actually fix the
measured failure: Jest reuses a worker across spec files, so the three guarded files can share one
worker and therefore one counter — the quota is per client and per minute, not per row. It would
also need a template database, worker-id *and* service-name namespacing (turbo runs the four
services concurrently, so `worker 1` is ambiguous), and `CREATEDB` in CI. Real machinery, bought
against a problem the evidence does not show: with the quota fixed, 337 stale job rows changed
nothing.

**Scoping every assertion to rows the suite created.** Already true of the suites that needed it,
and it cannot help here — the row that broke the run belongs to the guard, not to any suite.

**Serializing the DB-touching suites.** `--concurrency=1` was the diagnostic that first isolated
this, and it would have hidden rather than fixed it: verification-svc's suite trips the quota on its
own, one run after another, at any concurrency.

## Consequences

- A suite that creates rows without registering them is not caught during its own run — only on the
  next one, as a dirty database. That is the honest limit of a whole-table count when four suites
  share the table.
- `dispatch-fairness.spec.ts` scales its tick count to the number of active jobs *in the whole
  table*. Cleanup keeps that bounded; without it the suite got measurably slower every run.
- Raising the quota means the HTTP suites no longer exercise `AbuseGuard`'s rejection path at all.
  That is a deliberate trade, paid for by `abuse-guard.spec.ts` — which tests it better than the
  incidental coverage did, since it can assert the threshold instead of tripping over it.
- The quota's production default and database pool sizing are untouched. `DbModule` now closes its
  owned Prisma pool during normal Nest shutdown; the test-only size cap never reaches production.
- The test-only pool cap trades database concurrency inside one Jest worker for bounded connection
  use across all workers. These suites are assertion-bound rather than query-throughput benchmarks.
- Service-local serial execution trades intra-service parallelism for deterministic ownership and
  teardown. Cross-service concurrency remains, which is the concurrency ADR-015's row-ownership rule
  is designed to tolerate.
