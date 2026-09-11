# ADR-008: A rebuild attempt and a target's verdict are separate entities

> **Status**: Accepted 2026-08-12 (teki) · promoted from `Proposed` under the standing ruling that a `Proposed` status on shipped scope is a status nobody wrote back, and the state of the code decides it
> **Scope**: `packages/db`'s schema (new `Rebuild` model, `Job` model changes), the dedup logic
> in `services/verification-svc`, the dispatch/publish pipeline in `services/orchestrator-svc`,
> `services/builder`'s verify-mode hash extraction

## Context

`jobs` conflates two things that are only sometimes the same: *"compile this source with this
image and these options"* (a rebuild attempt) and *"does the result match what's deployed at this
target"* (a verdict). Today one `Job` row is both — `idempotency_key` (over source + image + build
options, deliberately excluding target) is `@unique`, so two different targets that happen to
share an identical rebuild recipe collide on the same row, and the dedup logic in
`submit.service.ts`'s `resolveExistingJob` hands the second submitter the *first submitter's own
verdict* (`deduped_terminal` returns `existing.result` verbatim, `deduped_in_flight` returns the
first submitter's `job_id`).

This is a real defect, not a hypothetical: `wasm_hash → contract_id` has no lookup (a given Wasm
can back any number of contract instances, on any number of networks — see
[ADR-007](ADR-007-by-hash-index-is-network-independent.md)), so "these two targets rebuild from
the same source" says nothing about whether they are *currently* the same bytes on chain. A
contract upgrade between the two submissions, or the two targets simply never having been the same
bytes to begin with, makes the borrowed verdict wrong — and the current code has no way to notice,
because it never re-checks anything before handing the borrowed result back.

The fix requires the rebuild (cacheable, chain-independent — a pure function of source+image+
options) and the comparison (never cacheable, chain-dependent — the deployed hash can change under
you) to become two things a data model can actually represent separately, so that sharing the
first and always redoing the second stops being a policy no one enforces and starts being the only
thing the code can do.

## Decision

1. **New `Rebuild` entity**, keyed by the existing idempotency formula (source_ref + image_digest +
   build_options), moved from `services/verification-svc`'s `idempotency.ts` into `packages/core`
   so `services/orchestrator-svc` can compute the same key. One row per distinct rebuild recipe,
   ever. Carries the Batch dispatch state (`batch_job_id`, `build_mode` — which attempt is
   current), and once terminal: `outcome`, `runner`, `rebuilt_wasm_hash`, `diagnostics`,
   `error_code`.

2. **`Job` keeps its own target and becomes a plain FK (`rebuild_id`) into `Rebuild`.** A job never
   borrows another job's verdict. `idempotency_key`, `batch_job_id`, `build_mode` are removed from
   `Job` — dispatch is now something a *rebuild* does, once, regardless of how many jobs end up
   attached to it.

3. **Every job independently computes its own `matched`**, always by re-fetching its target's
   *current* deployed hash at comparison time (never a value cached at submission time) and
   comparing it to the rebuild's `rebuilt_wasm_hash`. This applies uniformly — the job that
   happened to create the rebuild gets no special treatment over one that merely attached to it.
   `stellar contract verify`'s own internal verdict (its `success`/`comparison_mismatch`
   classification) stops being authoritative for `matched`; it becomes diagnostic only, because a
   shared rebuild's CLI-driven comparison was only ever run against *one* target's pinned hash, and
   every other attached job needs the raw rebuilt bytes' hash to run its own comparison — which
   requires `services/builder` to actually produce that hash on a CLI-reported mismatch, which it
   does not do today (see Consequences).

4. **A `cli_failure` → build-mode retry is a property of the rebuild, propagating to every
   attached job** — confirmed explicitly: when a shared rebuild needs the verify→build fallback,
   every job attached to it rides the same retry rather than being submitted independently.

5. **If a job's freshly-fetched deployed hash no longer matches what was pinned when the job was
   created** (the contract was upgraded mid-flight), the job still publishes its byte-level verdict
   via by-hash — `rebuilt_wasm_hash == the byte-fetched hash` is permanently true regardless — but
   **skips writing/updating the by-contract pointer** and records that the contract binding
   drifted. Confirmed explicitly, over failing the job outright or publishing both hashes for the
   reader to reconcile.

   > **Note (2026-08-07)**: `report-artifact` plan.md Phase 5 deleted the by-contract file this
   > point names, once `read-and-aggregate` shipped a replacement — address lookup is now resolved
   > per request against the ledger (real-time RPC), never a stored pointer. The mechanism
   > described above no longer exists; the decision it encoded still holds (never publish an
   > address→hash mapping that can go stale) — it is just enforced a different way now. Left
   > un-rewritten per this ADR's own convention (amend, never rewrite).

6. **A `cli_failure` rebuild is only terminal for the jobs already attached to it, not for future
   submissions.** Because a `Rebuild` is keyed on the recipe alone, a row left `done`/`cli_failure`
   after exhausting its one verify→build retry would otherwise make *every later resubmission of
   that recipe* inherit the failure forever — nothing else ever moves the row off `done`. A
   `cli_failure` means the tooling couldn't finish (crash, timeout, sandbox unavailable), which is
   not evidence the recipe is unbuildable, so a newly-created job that is the first to discover
   that stale terminal state resets the rebuild to `pending` and earns one fresh attempt, starting
   from `verify` again. CAS'd on (`status: done`, `outcome: cli_failure`) so concurrent attachers
   produce one reset, and scoped to `cli_failure` only: `success` and `comparison_mismatch` are
   legitimate, cacheable outcomes that resubmissions still share without rebuilding.

7. **A non-terminal state is never permanent — every waiting state is time-bounded.** `advance()`
   treats a rebuild in `dispatching`/`running` as "wait for someone else's Batch job", which is
   correct on the happy path and *permanent* if the terminal event never lands. Because a rebuild is
   shared, one wedged row strands every attached job in `comparing`; because `comparing` counts as
   active in `getActiveJobForTarget`, those jobs then refuse every new submission for their targets.
   So a single lost SQS message could make a contract permanently unverifiable. Two bounds close
   this:
   - **A reconciler** (`scheduler/rebuild-reconciler.scheduler.ts`) bounds both waiting states,
     differently because they mean different things. `dispatching` past
     `SCVS_REBUILD_DISPATCH_TIMEOUT_MS` is released back to `pending` (Batch almost certainly never
     accepted it, so re-dispatch is correct and cheap). `running` past `SCVS_REBUILD_RUN_TIMEOUT_MS` is
     never re-dispatched — that would duplicate a build that may still be alive — and is **not assumed
     dead** either: it is reconciled on three descending rungs of evidence.
     1. Ask AWS Batch (`batch:DescribeJobs`). Non-terminal (`RUNNING`/`RUNNABLE`/…) → leave the row
        untouched, however long it has been silent.
     2. Terminal, or Batch has no record → resolve from the builder's `recipe.json` through the same
        `RebuildOutcomeService` the SQS handler uses, so both paths cannot drift.
     3. Nothing on either rung → terminal `cli_failure` with `rebuild_timeout`. Recording it as
        `cli_failure` rather than inventing an outcome value keeps the existing `settle()` policy: a
        timed-out `verify` still earns its one `build`-mode retry.

     Because rung 1 distinguishes "alive" from "silent" instead of guessing,
     `SCVS_REBUILD_RUN_TIMEOUT_MS` is a reconciliation delay, not a do-not-kill-healthy-builds margin —
     which is what let its default drop from 90 minutes to 3. The earlier guess-based version had to
     outwait the longest legitimate build, and still reported a *passing* verification as a timeout
     failure whenever an event was lost.
   - **A staleness bound on in-flight dedup**: `getActiveJobForTarget` only matches jobs whose
     `updated_at` is within `SCVS_ACTIVE_JOB_DEDUP_STALE_MS`. Overshooting here is nearly free — a
     duplicate job attaches to the *same* rebuild, costing one row and no extra compile — whereas
     undershooting costs the target its ability to ever be re-verified, which is why the bound is
     deliberately shorter than the slowest build rather than longer.

8. **Reviving a rebuild re-opens the jobs it failed, and publication is bounded and visible.** Two
   consequences of a rebuild being shared, both found in production:
   - A job that gave up when the rebuild exhausted its retries stayed permanently `build_failed` while
     a later job on the revived rebuild published `verified` for the **same `wasm_hash`**. Whoever wins
     the revival CAS therefore also re-opens those jobs (`reopenJobsFailedByRebuild`), scoped by the
     `error_code` the rebuild carried, so a job that failed for its own target's reasons
     (`hash_mismatch`, an unresolvable chain lookup) is untouched. Re-opened jobs re-settle
     independently against a freshly-fetched deployed hash — never by copying the reviving job's answer.
   - A verdict that cannot be published left the job in `comparing` and was retried every minute
     forever, with nothing user-visible to distinguish it from a slow compile. Attempts are now counted
     on the job (`publish_attempts`), reported through `progress` as "attempt N of M", and bounded by
     `SCVS_MAX_PUBLISH_ATTEMPTS`. The underlying storage error stays in the log — `progress.detail` is
     served publicly and storage errors name buckets, prefixes and principals. An exhausted job keeps
     its computed verdict rather than being recorded as a build failure, because the bytes did match;
     re-arm it by resetting `publish_attempts` to 0.

9. **`getPublishedJobForTarget`'s "already_verified" short-circuit gets a re-check**: before
   trusting a prior publication for the *same* target, re-fetch the current deployed hash and
   compare it to what was recorded. A match returns the cached result as before; a mismatch falls
   through to a fresh submission, because the contract no longer holds the bytes that were
   verified.

## Amendment 2026-08-03 — this is a modelling decision, not a safety boundary

The Context above is an accurate description of a defect **in the code as written**: because
`idempotency_key` is `@unique` on `Job`, a second target has no row to occupy, so `resolveExistingJob`
reuses the first target's row and returns its verdict. That is real and this ADR's remedy fixes it.

What this ADR must **not** be read as claiming is the stronger, false proposition that a single-table
model is inherently unsafe. It is not. The property that prevents a borrowed verdict is:

> **every comparison re-fetches the target's current deployed hash, and verdicts are keyed by that
> hash — never by the recipe.**

A one-table model with `idempotency_key` **non-unique** plus a "has this recipe already produced a
rebuilt hash?" lookup satisfies that property completely. The uniqueness constraint is what makes the
bad behaviour unavoidable, by leaving the second target nowhere to go.

Accordingly:

- **The minimum correct fix is to drop the uniqueness constraint** (IMPLEMENTATION-SPEC §F.1, amended
  the same day). Work depending on a correct dedup path does not need this ADR accepted first.
- **Decision 1's separate `Rebuild` entity remains recommended**, on modelling grounds that stand on
  their own: dispatch state gets exactly one owner, the single verify→build retry has one place to
  live, and the build product stops being stored once per attached job.
- Decisions 3, 5, 6, 7 and 9 are **behavioural** and hold under either schema.
- **★ Amended 2026-09-01: the verify→build retry no longer exists.** Everything below about
  it records why the rebuild entity was shaped to hold it, and that argument stands — dispatch state
  still wants exactly one owner. But `selectBuildMechanism` has produced only `build` since the CLI
  mechanism was retired, so nothing could earn the demotion, and `earnsBuildModeRetry` /
  `requeueForRetry` are deleted. `requeueStaleCliFailure` — decision 7's re-open, a *fresh* attempt
  rather than a demotion — is untouched and is now the only thing that moves a terminal rebuild back to
  `pending`. See
  `../features/sandbox-hardening/decisions/the-verify-retention-window-is-closed.md`.
- Decision 6's "starting from `verify` again" is superseded: the one retry ran in **build** mode,
  through the sandbox — a cli-legacy recipe has no on-chain recipe for `stellar contract verify` to
  read, so a verify-mode retry cannot succeed for it (TRD §4.3, §4.4).
- Decision 8's **first** bullet — reviving a rebuild re-opens the jobs that rebuild had failed, scoped
  by the failure's `error_code` — **is adopted**. It is the rebuild-versus-job split of decision 3
  applied in the withdrawing direction: a rebuild-scoped failure propagated to every attached job, so
  withdrawing it must propagate the same way, or the verifier holds two contradictory answers for one
  `wasm_hash`. Stated in `docs/design/data-and-lifecycle.md` §4.
- Decision 8's second bullet (bounded `publish_attempts`, `publish_abandoned`) **conflicts with
  IMPLEMENTATION-SPEC AP4**, which requires a durable pending state to be retried and never dropped.
  The spec governs; the bounded budget is recorded as a divergence in
  `trd-conformance.md`, not adopted as target state.

## Consequences

**Easier**

- Cross-target rebuild sharing becomes correct instead of merely convenient — the thing steps 1–2
  of this conversation's grilling process concluded should be true (verdict primary key is
  `wasm_hash`, computed fresh, never borrowed) is now enforceable at the data-model level rather
  than an unenforced convention.
- `services/verification-svc`'s `submit.service.ts` gets *simpler*, not more complex: it stops
  computing or looking up idempotency keys at all. It creates a job, full stop; `orchestrator-svc`
  is the only place that ever decides whether that job dispatches a new rebuild, attaches to an
  in-flight one, or resolves immediately against an already-terminal one.

**Harder / constrained**

- **`services/builder`'s verify-mode mismatch path does not currently expose the rebuilt Wasm's
  own hash** — only the success path extracts one (`extractVerifiedHash`, from the CLI's own
  stdout). Making cross-target sharing correct on a *mismatch* outcome (not just success) requires
  the builder to self-hash the rebuilt bytes regardless of the CLI's verdict. The CLI has a
  `--keep` flag ("keep the materialized source and rebuild output ... and print the path") built
  for exactly this — the fix is to always pass it and `sha256`-hash whatever it leaves behind,
  the same way the "build" (fallback) mode already hashes its own output today. **This is reasoned
  from the CLI binary's own help text and from Rust error-variant name strings found in it
  (`VerificationMismatch { original_hash, original_size, rebuilt_hash, rebuilt_size }`), not from a
  live run of a real mismatch** — no real SEP-58-mismatching contract was available to test against
  in this session. Treat the exact `--keep` output path format as unverified until a live Batch
  smoke test confirms it, the same standard this project already holds itself to for CLI-behavior
  claims (see the AWS Batch spike's own verification bar).
- A genuine behavior change for submitters: two different targets sharing a rebuild recipe used to
  get an *instant* synchronous answer (borrowed from whichever target got there first) — now the
  second submitter always gets `202 queued` and waits for `orchestrator-svc`'s next poll tick to
  discover and attach to the shared rebuild, even if that rebuild is already finished. This is the
  cost of correctness (Consequence, not a regression to hide): the old instant answer was
  frequently wrong.
- Dispatching a rebuild exactly once needs a compare-and-set claim (`Rebuild.status: "pending" →
  "running"`), because more than one job can discover the same not-yet-dispatched rebuild in the
  same poll tick. This mirrors the existing `requeueFailedJob` CAS pattern already proven in this
  codebase, applied one level up.
- `Job` failure reasons split by scope for the first time: `policy_rejected`/`source_unreachable`/
  `build_timeout` are properties of the *rebuild* now (propagate to every attached job identically
  on a permanent failure); `missing_fields`/`hash_mismatch`/chain-lookup `internal_error` stay
  properties of the individual *job*'s own target resolution. Getting this split wrong would leak
  one job's target-specific problem onto every other job sharing its rebuild, or vice versa.

## Alternatives considered

- **Keep one `Job` row per idempotency key; add a re-verify step before returning a borrowed
  result** — rejected: this was this conversation's own first proposal (Q1) before the deeper
  problem surfaced (Q3/W1) that *in-flight* sharing has the identical bug via `deduped_in_flight`,
  not just the terminal case, and a job-level fix can't express "N independent verdicts share one
  compile" without inventing exactly the second entity this ADR proposes anyway.
- **Drop cross-target rebuild sharing entirely; one job, one dispatch, always** — rejected: throws
  away a real cost saving (identical open-source contracts deployed to multiple targets/chains
  would each pay a full sandboxed rebuild) to avoid a data-modeling problem that has a correct
  solution.
- **Keep `stellar contract verify`'s own classification as authoritative for the job that created
  the rebuild, self-hash only for attached jobs** — rejected for consistency: two different code
  paths computing `matched` two different ways for what is conceptually the identical operation
  (compare rebuilt bytes to a deployed hash) is exactly the kind of asymmetry that hides bugs;
  self-hashing uniformly costs nothing extra once builder does it at all.

## References

- This session's grilling rounds on the `verify` dispatch path (2026-07-30) — Q1–Q3, W1–W6
- [ADR-007](ADR-007-by-hash-index-is-network-independent.md) — the `wasm_hash`-is-primary-key
  premise this ADR builds on
- `docs/features/_ARCHIVED/rebuild-verdict-split/design.md` — schema, state machine, and the phased plan
- `services/verification-svc/src/modules/verifications/idempotency.ts` (to move),
  `packages/db/prisma/schema.prisma`, `services/builder/src/modules/builder/run-cli.ts`
