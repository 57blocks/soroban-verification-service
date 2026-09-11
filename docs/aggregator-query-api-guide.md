# Aggregator Query API guide

> **Audience**: a developer querying an aggregator's Public Query API (`query-svc`) directly over HTTP
> — no SDK, no client library.
> **Shape authority**: same rule as the [submission API guide](submission-api-guide.md) — this
> document covers routes, flow, and the two fields most likely to be misread. For exact request/
> response shapes, use `/api/query/v1/docs` (Swagger UI, already mounted) or the generated
> `services/query-svc/openapi.json`.
> **Not this document**: how a verifier publishes what an aggregator reads — see
> [`docs/reading-the-result-tree.md`](reading-the-result-tree.md) for the producer side of what this
> guide queries.

## The four routes

### By hash

`GET .../v1/wasms/:wasm_hash`

The aggregated status for one Wasm hash — one entry per verifier that has an opinion about it. Assembled
fresh per request, not served from a pre-built file — this is a live read, not a static one.

### By contract

`GET .../v1/contracts/:network/:contract_id`

Resolves a contract address to a Wasm hash, then answers the same as the by-hash route. **The address
is re-resolved on every request, never read from a cached mapping** — a contract can be upgraded to a
new Wasm at any time, so caching this mapping would silently serve a stale hash after an upgrade. Bad
input is `invalid_contract_id` / `invalid_network` (400); a contract that doesn't resolve at all is
`contract_not_found` (404); a resolution-service failure is `address_resolution_failed` (502).

### Bulk load

`GET .../v1/wasms` (cursor-paginated: `order`, `limit` up to 200, `cursor`)

The route to build a synchronising integration against — walk this with the cursor rather than
guessing at hash values. `cursor` is `{timestamp}-{wasm_hash}` (milliseconds since the epoch, decimal,
then a hyphen, then the Wasm hash) — but **don't construct one yourself**: pass back exactly the
`cursor` string the previous page's response carried, and treat its format as opaque. A response with no
further pages sets `cursor` to `null`; a malformed or invalid one you did construct is a 400
`invalid_cursor`.

**Before the aggregator's first sync completes, this returns 503
`aggregation_unavailable` rather than an empty page.** That distinction is deliberate: an empty page and
"nothing has been verified yet" look identical to a naive consumer, and a consumer that can't tell them
apart records "fully synchronised, zero results" the first time it happens to poll during startup — this
status code exists so that mistake isn't possible. Don't treat a 503 here as a transient error to
silently retry into an empty-page assumption; wait for it to clear into real pages.

### Verifiers list

`GET .../v1/verifiers`

The aggregator's current Trusted Verifiers List — every member it aggregates, paused and disabled ones
included. This is the aggregator's own document about itself, not something any one verifier controls;
see [`docs/verifier-onboarding.md`](verifier-onboarding.md) if you're on the *publishing* side of this
relationship instead of the querying side.

## Two fields that are easy to misread

### `agreement`

A **descriptive summary** of the entries in *this specific response* — never a verdict, and never a
substitute for reading the underlying per-verifier list yourself. Concretely, one of: `no_data` (no
entries at all), `single` (exactly one verifier has an opinion), `disputed` (some verifiers say
verified, others say mismatched), `unanimous_verified`, `unanimous_mismatched`, or `unverified_only`
(entries exist but none reached a verified/mismatched conclusion). If your integration needs a single
yes/no answer, apply your own rule to the entry list — that choice is yours to make based on which
verifiers you trust, and `agreement` deliberately does not make it for you.

### `unavailable_verifiers`

Always present, even when empty. Lists verifiers the aggregator could not reach **for this request** —
not a permanent blacklist, and not the same thing as a verifier being removed from the TVL. A verifier
that stays unreachable across many requests keeps appearing here every time rather than being quietly
dropped from future responses; this is what makes "an aggregator never silently omits a verifier"
checkable rather than just asserted. Don't treat repeated appearance here as a sign your integration is
doing something wrong — it's a sign that specific verifier is down or unreachable from the aggregator's
side.

## Minimal example

```bash
# One hash, every verifier's opinion on it
curl https://query.example.org/api/query/v1/wasms/$WASM_HASH | jq .

# Walk the full synchronised set
CURSOR=""
while :; do
  PAGE=$(curl -s "https://query.example.org/api/query/v1/wasms?limit=200${CURSOR:+&cursor=$CURSOR}")
  echo "$PAGE" | jq -c '.records[]'
  CURSOR=$(echo "$PAGE" | jq -r '.cursor // empty')
  [ -z "$CURSOR" ] && break
done
```

For a typed client that already handles pagination, redirect policy, and error shapes for you, see
[`clients/sdk/README.md`](../clients/sdk/README.md) — `newHostedClient({ baseUrl })` covers everything
in this guide with one call per route above.
