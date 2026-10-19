# Read the result tree directly

Every verifier publishes its results as static files under one HTTPS URL, its **result root**. Reading
them needs no API, no account and no client library, and keeps working when the verifier's own service is
down. It is also what an aggregator reads.

The trade-off: you read one verifier at a time, one Wasm at a time. To ask many verifiers at once, use an
aggregator's [Query API](./query-across-verifiers.md).

## What is under a result root

| Path | Holds | Changes |
| --- | --- | --- |
| `wasms/<wasm_hash>.json` | The **status object**: this verifier's current result for the Wasm | Rewritten by each new verdict, and when a permanent copy or the source is added |
| `reports/<sha256>.json` | A **report**: the full record of one verification. Named by the SHA-256 of its own bytes | Never |
| `sources/<sha256>.<ext>` | A source archive its submitter declared public | Never |
| `verifier-manifest.json` | Who this verifier is: its `id`, `display_name`, its result root as `url`, and `policy_url` | Rewritten when the verifier restarts |
| `policy.json` | What this verifier will verify: the build-image trust levels it accepts, how it takes source, and what it retains | Rewritten when the verifier restarts |

The Wasm hash in a status object's path is lowercase. There is no index file: to list everything a
verifier has published, use its bulk-load route, below.

[Result documents](../api/result-documents.md) describes every field, with the JSON Schemas.

## Reading one result

```sh
ROOT=https://results.example.org      # the verifier's result root
WASM_HASH=…                           # 64 lowercase hex characters

curl -s "$ROOT/verifier-manifest.json" | jq '{id, display_name, url}'
curl -s "$ROOT/wasms/$WASM_HASH.json" -o status.json
jq --arg root "$ROOT" '.source_code_verifications[] | select(.verifier.url == $root)
  | {status, recipe_source, image_trust_level, processed_at}' status.json
```

A status object holds this verifier's own entry, under its result root as `verifier.url`; pick it by that
URL rather than by position. A Wasm this verifier has no result for has
no file; depending on the host, that reads as `404`, or `403` from a storage host that hides which files
exist. Treat both as "no result from this verifier".

On S3-compatible storage, status objects, the manifest and the policy are served with a one-minute
cache lifetime, because they change, and reports are cached indefinitely, because they never do. Other
hosts set their own.

## Checking what you read

A report's file name is the SHA-256 of its bytes, and the status object gives that hash beside each copy
of the report, so you can confirm the report you fetched is the one that was published:

```sh
REPORT=$(jq -c --arg root "$ROOT" '.source_code_verifications[] | select(.verifier.url == $root)
  | .results_urls[] | select(.type == "report")' status.json | head -1)
curl -s "$(jq -r .url <<<"$REPORT")" -o report.json
echo "$(jq -r .sha256 <<<"$REPORT")  report.json" | sha256sum -c -
```

A copy archived to Arweave appears as a second `results_urls` entry, with `"location": "arweave"`, a
gateway URL, and the same SHA-256. It outlives the verifier's own storage.

The status object itself is not signed or content-addressed: it is the verifier's current claim, and you
trust it as far as you trust the verifier and its HTTPS host. The report it points to is what you can
check byte for byte.

## Listing a verifier's results

The static tree has no listing, so a verifier that runs this software also serves its own bulk load, from
its API rather than its result root:

```sh
curl -s "$ORIGIN/api/verification/v1/wasms?limit=200" | jq .
```

Each page lists `{wasm_hash, updated_at}` records, oldest change first, and a `cursor` for the next page,
or `null` on the last one. Pass the cursor back exactly as you received it. A Wasm reappears with a later
`updated_at` whenever its status object changes, so upsert by `wasm_hash`. Then fetch each status object
from the result root.

The same API also serves a status object at `GET /api/verification/v1/wasms/<wasm_hash>.json`,
byte-identical to the file and read straight from storage, so it is never behind a cache. One exception:
while any verification of that Wasm is queued or running, a dry run included, it answers `202` with a
single `unverified` entry in place of the published object. Both routes are rate-limited; the result root
is not.

## From a browser

The verifier's API allows requests from any origin. Whether a browser can read the result root directly
depends on the host serving it, and its cross-origin settings; this software does not configure them. If
your page cannot, read through the API's copy, or through an aggregator.
