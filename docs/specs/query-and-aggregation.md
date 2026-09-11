# Query and aggregation

As built. See `Verified by:` on each claim.

Route usage and examples: [`docs/aggregator-query-api-guide.md`](../aggregator-query-api-guide.md).
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
`test/integration/cases/qry/qry-peer-outage.spec.ts` (E2E-QRY-09, retained aggregate survives a
peer outage, `unavailable_verifiers` names the failure).

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
error, not an aggregation over an unknown hash.

Verified by: `services/query-svc/src/modules/results/stellar-rpc.resolver.ts`,
`services/query-svc/src/modules/results/address-resolver.ts`;
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

## Availability: a failing verifier bounds only its own contribution

A slow or unreachable verifier never blocks or degrades the response for the others — its absence
is named in `unavailable_verifiers`, and the aggregate still returns every reachable verifier's
entry. The last successful result per verifier is retained and served, labelled with its retrieval
time, while that verifier is unreachable. The retained copy is a cache, not a store of record: it
is derived from result roots and discardable, which is what keeps this layer replaceable by any
other implementation reading the same TVL and result roots.

Verified by: `test/integration/cases/qry/qry-peer-outage.spec.ts` (E2E-QRY-09).

## The SDK's aggregation mode

Client-side aggregation over result roots is a first-class mode, not a fallback: the SDK can
produce the identical aggregated shape with no hosted Public Query API involved, by reading the
TVL and each verifier's result root directly. Every fetched artifact is treated as untrusted input
— content is checked against the `sha256` the status object carries before it is parsed or
surfaced.

Verified by: `clients/sdk/src/registry-read.ts` (`validateStatusObject`, `computeAgreement`);
`clients/sdk/test/registry-read-test.ts`.
