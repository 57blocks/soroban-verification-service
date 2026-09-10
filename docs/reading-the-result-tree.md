# Reading the result tree directly

> **Audience**: an integrator who wants to read a published verification result over plain HTTPS — no
> API, no SDK, just a `GET` against a verifier's (or an aggregator's) static result tree.
> **Shape authority**: [`docs/results-sep/README.md`](results-sep/README.md) and its schemas are the
> wire contract for what these documents actually contain. This guide covers the key layout — where a
> document lives, not what's inside it — and cites `packages/storage-layout/src/keys.ts` as the
> authority for exact paths.

## Why read this way at all

Every verifier publishes its results as plain, readable files at a fixed set of paths — its **result
root**. This is not a fallback or a degraded mode: it's the primitive the rest of the ecosystem is
built on. Reading it directly means:

- **It keeps working when the verifier's own service is down.** A published file doesn't care whether
  any process is currently running.
- **It's what an aggregator itself reads.** There is no fresher or more authoritative path to a
  verifier's results than the tree an aggregator would read from — going straight to it skips no
  freshness, only convenience.
- **No rate limit, no API quota, no client library dependency** — just whatever your HTTP client
  already does.

The tradeoff: you get exactly what's published, one document at a time, with none of an API's
convenience (no aggregation across verifiers, no cursor-paginated walk unless the verifier also serves
a bulk-load route — see [`docs/aggregator-query-api-guide.md`](aggregator-query-api-guide.md) for that
served-route alternative, and [`docs/verifier-onboarding.md`](verifier-onboarding.md)'s note on
`bulk_load_url` for why not every verifier offers one).

## The paths that matter

Relative to a verifier's result root (its published base URL):

| Path | What's there |
| --- | --- |
| `reports/<sha256>.json` | The full report artifact for one build attempt, keyed by a hash over the report's own content |
| `wasms/<wasm_hash>.json` | The status object for one deployed Wasm hash — the Registry API's per-hash status shape |
| `verifier-manifest.json` | The verifier's self-description — identity, and the URL templates that resolve the two paths above for a given hash |
| `policy.json` | What this verifier does and doesn't verify, generated from its live configuration |

These four are the ones worth memorizing; the exact schema of what's inside each is
[`docs/results-sep/`](results-sep/README.md)'s job to define, not this document's to restate.

**Always resolve a path through the verifier's manifest template rather than hand-constructing it from
this table.** The table shows the convention this project's own implementation follows; a manifest's
templates are the specific verifier's actual, authoritative paths — if a manifest and this table ever
disagree for a given verifier, the manifest is right and this table is stale.

## A direct read, start to finish

```bash
# 1. Get the verifier's self-description, including its manifest URL templates
curl https://results.example.org/verifier-manifest.json

# 2. Fetch a specific Wasm hash's status directly
curl https://results.example.org/wasms/$WASM_HASH.json

# 3. Fetch the full report artifact it points to, if you need build-level detail rather than the summary
curl https://results.example.org/reports/$REPORT_SHA256.json
```

None of these three calls touch any API route, any rate limit, or any code in this repository at
runtime — they're plain static-file GETs, and would work identically against a verifier that ran none
of this project's code at all, as long as it published to the same conventions.

## What this document is not

Not a tutorial on `@scvs/sdk` — [`clients/sdk/README.md`](../clients/sdk/README.md) already covers
reading results through a typed client, including validating a fetched manifest and following its
templates for you. Read this document if you want to skip even that; read the SDK's if you'd rather not
hand-roll URL construction and response validation yourself.
