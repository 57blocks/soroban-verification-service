# Query across verifiers

An **aggregator** reads the results of several verifiers and answers for all of them in one response.
Its Query API is the quickest way to show what the verifiers it reads say about a contract. Every route
is a `GET` under `/api/query/v1` and needs no key. By default, a browser can call it from any origin.

<ThisOrigin />

## By contract

```sh
curl -s "$ORIGIN/api/query/v1/contracts/mainnet/$CONTRACT_ID" | jq .
```

The aggregator asks the ledger which Wasm the contract runs, on every request, then answers as for that
Wasm hash. The response names the `wasm_hash` but not the contract. An upgraded contract runs a new Wasm,
so cache results by Wasm hash, never by address.

| `error` | HTTP | Means |
| --- | --- | --- |
| `invalid_network`, `invalid_contract_id` | 400 | The network is not `mainnet` or `testnet`, or the address is not a contract address |
| `contract_not_found` | 404 | Nothing at that address runs a Wasm. A Stellar Asset Contract ends here too |
| `address_resolution_failed` | 502 | The ledger could not be read. Retry |

Resolving an address costs the aggregator a call to the ledger, so this route has a much tighter rate
limit than the others. To look up many contracts, resolve each address once and then query by hash.

## By Wasm hash

```sh
curl -s "$ORIGIN/api/query/v1/wasms/$WASM_HASH" | jq .
```

The same response, without the ledger call. The hash is not validated: a malformed one is simply a hash
nobody has a result for, and answers `no_data`, so check it is 64 hexadecimal characters first.

## The response

```json
{
  "schema": "stellar-verification-aggregate",
  "schema_version": "1.0",
  "wasm_hash": "96ae13fb…",
  "updated_at": "2026-10-19T08:00:00.000Z",
  "agreement": "single",
  "unavailable_verifiers": [],
  "source_code_verifications": [
    {
      "verifier": { "url": "https://results.verifier.example", "name": "Example Verifier" },
      "status": "verified",
      "recipe_source": "on_chain_metadata",
      "image_trust_level": "official_trusted",
      "processed_at": "2026-10-15T07:46:30.802Z",
      "retrieved_at": "2026-10-19T07:59:12.000Z",
      "schema_version": "1.0",
      "results_urls": [{ "type": "report", "location": "verifier_self_storage", "url": "…", "sha256": "…" }]
    }
  ]
}
```

- **`source_code_verifications`** holds one entry per verifier with a result for the Wasm: the entry
  that verifier published, with its recipe fields, as the aggregator last read it. The aggregator adds
  `retrieved_at`, when it read the entry, and `schema_version`, the version of the document it read it
  from. `verifier.url`, the verifier's result root, is its identity.
- **`agreement`** sums the entries up. It is a description, not a verdict.
- **`unavailable_verifiers`** lists the verifiers the aggregator could not read on its latest attempt.
- **`updated_at`** is when this response was put together, not when any result changed.

[Interpret multi-verifier results](./interpret-multi-verifier-results.md) explains how to turn this into
what your application shows.

## How fresh the answer is

The aggregator does not fetch anything when you ask. It reads each verifier in the background, about
once a minute by default, and answers from what it has read:

- A new result usually reaches the aggregator within a few minutes of being published; longer when a
  verifier publishes many results at once, since each pass reads at most 200 changes from each verifier.
  To know the moment a verdict exists, follow the job, or ask the verifier itself.
- The aggregator re-reads an entry only when the verifier reports a change to it, so an old
  `retrieved_at` is normal for a result that has not changed.
- Right after an aggregator starts, until it has made one pass over its verifiers, the result routes
  answer `503` with `aggregation_unavailable`. That is not "no results": wait and retry. Results can go on
  filling in for a while after the first pass.

## Every result, page by page

To keep your own copy of everything the aggregator knows, walk its bulk load:

```sh
CURSOR=$(cat cursor.txt 2>/dev/null || true)   # where the last walk stopped, if any
while :; do
  PAGE=$(curl -s "$ORIGIN/api/query/v1/wasms?limit=200${CURSOR:+&cursor=$CURSOR}")
  jq -c '.records[]' <<<"$PAGE"                 # one full aggregate per Wasm hash
  NEXT=$(jq -r '.cursor // empty' <<<"$PAGE")
  [ -n "$NEXT" ] || break
  CURSOR=$NEXT
done
printf '%s' "$CURSOR" > cursor.txt             # the cursor that fetched the last page
```

Records are ordered by when the set of results for that Wasm last changed, oldest first by default
(`order=desc` reverses it); `limit` is 1 to 200. Pass the cursor back exactly as you received it.

The last page's `cursor` is `null`, so keep the cursor that fetched it, as above, and start the next walk
from there. A Wasm reappears whenever its results change, so upsert by `wasm_hash`. A Wasm whose results
are all withdrawn, because its only verifier was disabled or withdrew the result, drops out of the bulk
load without a record saying so; to keep an exact copy, walk again from the beginning now and then.

## Which verifiers it reads

```sh
curl -s "$ORIGIN/api/query/v1/verifiers" | jq '.verifiers[] | {display_name, url, status, trust_tier}'
```

This is the aggregator's **Trusted Verifiers List**, chosen by its operator. Each member is:

- `active`: read regularly;
- `paused`: no longer read, but the results last read from it are still served;
- `disabled`: its results are removed from every answer.

`trust_tier` is the operator's own label, if any; it does not change how results are counted. The list's
`updated_at` is the time of the request, so compare entries, not that field, to see whether membership
changed. See [Trust model](../introduction/trust-model.md).

## Rate limits

Limits are counted per caller address and per route, in one-minute windows. The defaults are 600
requests a minute on each route, and 60 on the by-contract route. A request over a limit answers `429`
with `rate_limited` and a `Retry-After` header; being limited on one route does not limit the others.
An operator can set other limits, so read the `429` rather than hard-coding a rate.

[Errors](../api/errors.md#query-api) lists every error. The API reference describes each route:
<a href="/docs/api/query/query-by-contract">by contract</a>, <a href="/docs/api/query/query-by-hash">by
hash</a>, <a href="/docs/api/query/aggregated-bulk-load">bulk load</a> and
<a href="/docs/api/query/list-verifiers">verifiers</a>.
