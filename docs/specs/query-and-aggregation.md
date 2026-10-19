# Query and aggregation

As built. See `Verified by:` on each claim.

Route usage and examples: the documentation site's
[Query across verifiers](../../clients/docs/src/integrators/query-across-verifiers.md).
Wire format: [`docs/results-sep/sep-contract-verification-aggregation.md`](../results-sep/sep-contract-verification-aggregation.md).
This document states the behavioral promises neither of those covers.

## No global verdict

The aggregated response is a list of per-verifier attributed entries, never a merged verdict.
Disagreement between verifiers is a legitimate outcome, not an inconsistency the layer resolves —
each entry carries its own status and the policy that produced it. The layer does not rank, vote,
or pick a winner.

Verified by: `test/integration/cases/qry/qry-aggregation.spec.ts` (E2E-QRY-01, "each verifier
appears in its own right; there is no merged verdict").

A verdict attaches to a Wasm hash, not a network — see [rule 12](../invariants.md).

## Aggregated ordering

An aggregated bulk-load stream cannot page over any single verifier's own ordering, because
verifiers' publication clocks are independent and none is guaranteed reachable. The stream's own
rules:

- The sort key is this aggregator's own update time for a `wasm_hash` — never a verifier's
  publication time. It advances when any verifier's entry for that hash appears, changes, or is
  withdrawn.
- One record per `wasm_hash`, carrying every verifier's entry — not one record per
  `(hash, verifier)` pair.
- Cursor form is `{timestampMs}-{wasm_hash}`; a consumer upserts by `wasm_hash` on every page,
  because re-delivery after an outage is expected, not duplication.
- A verifier unreachable while a page is assembled is named in that page's
  `unavailable_verifiers` — a page is never delayed and never silently omits a verifier to wait
  for one.

Verified by: `services/query-svc/src/modules/aggregation/aggregation-sync.service.ts`
(the aggregation record's own `updated_at` as sort key, `unavailable_verifiers` on failure);
`test/integration/cases/qry/qry-bulk-load.spec.ts` (E2E-QRY-08, cursor form and monotonic advance);
`services/query-svc/test/aggregation.spec.ts` (serves retained peer evidence while naming the peer's
failed sync).

## Verifier discovery: manifest, policy, and the Trusted Verifiers List

Three documents answer three different questions, authored by two different parties:

| Document | Authored by | Answers |
| --- | --- | --- |
| `verifier-manifest.json` | The verifier, about itself | Who published this |
| `policy.json` | The verifier, about itself | What this verifier will and will not verify |
| Trusted Verifiers List | The aggregating operator | Which verifiers this deployment aggregates, and each one's `trust_tier`/`status` |

The split is load-bearing: a verifier describes itself, but does not admit itself to anyone's TVL
and does not set its own trust tier. There is no verifier-registration API — admission is the
operator's decision, and a shared sign-up list would be the chokepoint per-verifier attribution
exists to avoid (the same reasoning behind [rule 17](../invariants.md)'s refusal of a shared
build-environment registry).

Verified by: `test/integration/cases/qry/qry-aggregation.spec.ts` (E2E-QRY-01 reads the TVL and
cross-checks each active verifier's root appears in the aggregate).

## Address lookup: resolved per request, never published as a file

Address → Wasm hash resolution is this deployment's extension to the Results SEP (which
deliberately excludes it, since an address-to-hash mapping is not stable across contract
upgrades). It is always resolved live against the ledger via `@stellar/stellar-sdk`'s RPC — never
cached or published, because a stale pointer for an upgraded contract would attribute a verdict to
code no longer deployed. A resolution failure (malformed address, unknown network) is a request
error, not an aggregation over an unknown hash. A ledger that cannot be read is `502
address_resolution_failed` with a fixed message: the upstream error names the configured RPC
endpoint, which can carry a provider key, so it goes to the log and never to the caller.

Verified by: `services/query-svc/src/modules/results/stellar-rpc.resolver.ts`,
`services/query-svc/src/modules/results/address-resolver.ts`,
`services/query-svc/test/address-resolver.spec.ts` (an upstream failure reaching the caller);
`test/integration/cases/qry/qry-address-and-openness.spec.ts` (malformed address rejected,
well-formed-but-undeployed reported not-found, repeated reads create no address-keyed file).

## No enqueue from a GET

Nothing on the public query surface accepts a write. A result query, including one for a
never-seen hash, never creates a job or triggers verification — the only path to a rebuild is the
Verification API's own rate-limited submission route.

Verified by: `services/query-svc/src/modules/results/results.controller.ts`,
`services/query-svc/src/modules/aggregation/bulk-load.controller.ts` (every route is `@Get`, none
is `@Post`); `test/integration/cases/qry/qry-address-and-openness.spec.ts` ("reads a never-seen
hash forty times and creates nothing", "ignores a plausible enqueue parameter rather than
honouring it").

## Abuse control

The read surface is public and unauthenticated, so a per-caller quota is what stands in for the
account it does not have. Two tiers, and the relation between them is the point: a general budget
wide enough that a reader never meets it, and a much tighter one on
`GET /v1/contracts/{network}/{contract_id}` — the only route that reaches a third party, where one
admitted request costs one outbound Soroban RPC call. Both are stricter than nothing and looser
than the Verification API's submission tiers, which is the ordering `docs/specs/submission.md`
states from the other side.

A refused request returns `429` carrying `rate_limited` in the shared error envelope, never an
opaque body and never a `5xx`: a quota that sheds load by falling over is not a quota. Health and
configuration-contract routes are exempt — a probe refused with `429` is a probe that failed.

The OpenAPI document and its Swagger UI are registered on the HTTP adapter rather than through the
router, so no route-level guard is consulted for them; they are covered by middleware on the same
counter instead, under a budget of their own. Reading the document to exhaustion therefore costs a
caller nothing of its ability to query.

The counter itself is the workspace's own, shared with the Verification API. `@nestjs/throttler`'s bundled in-memory storage keys its
decay timers by throttler name rather than by caller, so unblocking one caller cancels every
caller's pending decrement and freezes their counts — a caller who cycles in and out of the blocked
state ratchets everyone else's count up until they are refused inside their own budget.

The quota bounds what one caller extracts. It is not a bound on this deployment's aggregate
outbound rate to an upstream RPC endpoint, which many callers across many tasks can still exceed.

It is also a per-process count, with no tier shared between tasks. A caller outside the balancer
therefore meets the task count times the configured ceiling, so the end-to-end case asserts that
excess is refused and refused cleanly, and deliberately does not assert what the ceiling is. That the
ceiling a deployment configures is the ceiling it runs is a deploy-time property, checked where the
task definition is rendered from the contract — not something a client can measure through a
balancer.

Verified by: `packages/http/src/fixed-window-throttler.storage.ts` (FixedWindowThrottlerStorage),
`packages/http/src/fixed-window-throttler.storage-test.ts` (does not inherit a neighbour's count),
`packages/http/src/adapter-route-throttle.middleware.ts` (adapterRouteThrottle),
`services/query-svc/test/quota-config.spec.ts` (the two tiers' ordering),
`packages/http/src/rate-limit.guard.ts` (rate_limited),
`services/query-svc/src/app.module.ts` (ThrottlerModule),
`services/query-svc/src/modules/results/results.controller.ts` (queryByContract),
`services/query-svc/test/rate-limit.spec.ts` (the global read quota,
the address route's tighter tier, routes exempt from the quota),
`services/query-svc/test/trust-proxy.spec.ts` (trust proxy),
`test/integration/cases/qry/qry-13-read-quota.spec.ts` (E2E-QRY-13),
`test/integration/cases/sec/sec-surface-and-quota.spec.ts` (E2E-SEC-12).

## Readiness reports the dependency the reads need

Every route but the health tree reads Postgres, so readiness is false while the database is
unreachable — answering "ready" then keeps an instance that can serve nothing in the balancer's
target group. The check is bounded by a timeout below the balancer's own, because a probe that hangs
tells it less than one that answers "not ready". Liveness is the opposite and stays dependency-free:
a liveness probe that fails on a dependency turns a database blip into a restart loop.

Verified by: `services/query-svc/src/modules/health/health.controller.ts` (getReady),
`packages/db-query/src/db-health.service.ts` (ping),
`services/query-svc/test/readiness.spec.ts` (turns false when the database is unreachable,
answers rather than hanging when the database stops responding).

## Availability: a failing verifier bounds only its own contribution

A slow or unreachable verifier never blocks or degrades the response for the others — its absence
is named in `unavailable_verifiers`, and the aggregate still returns every reachable verifier's
entry. The last successful result per verifier is retained and served, labelled with its retrieval
time, while that verifier is unreachable. The retained copy is a cache, not a store of record: it
is derived from result roots and discardable, which is what keeps this layer replaceable by any
other implementation reading the same TVL and result roots.

Verified by: `services/query-svc/test/aggregation.spec.ts` (serves retained peer evidence while
naming the peer's failed sync).

## The SDK's aggregation mode

Client-side aggregation over result roots is a first-class mode, not a fallback: the SDK can
produce the identical aggregated shape with no hosted Public Query API involved, by reading the
TVL and each verifier's result root directly. Every fetched artifact is treated as untrusted input
— content is checked against the `sha256` the status object carries before it is parsed or
surfaced.

Verified by: `clients/sdk/src/registry-read.ts` (`validateStatusObject`, `computeAgreement`);
`clients/sdk/test/registry-read-test.ts`.
