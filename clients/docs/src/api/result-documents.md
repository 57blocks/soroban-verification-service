<script setup>
import { sourceIsPublic } from "../../../web/src/config/site.ts";
</script>

# Result documents

Every document on the read side carries a `schema` and a `schema_version`, and each has a JSON Schema
in the [Results SEP](#the-results-sep). The examples below are the shapes this software emits.

| `schema` | What it is | Served by |
| --- | --- | --- |
| `stellar-verification-status` | One verifier's current result for a Wasm hash | A verifier's result root, at `wasms/<wasm_hash>.json`, and `GET /api/verification/v1/wasms/{wasm_hash}.json` |
| `stellar-verification-page` | One page of a bulk load | `GET /api/verification/v1/wasms` on a verifier; `GET /api/query/v1/wasms` on an aggregator, with aggregated records |
| `stellar-verification-aggregate` | Every listed verifier's result for a Wasm hash | `GET /api/query/v1/wasms/{wasm_hash}` and `GET /api/query/v1/contracts/{network}/{contract_id}` |
| `stellar-trusted-verifiers-list` | The verifiers an aggregator reads | `GET /api/query/v1/verifiers` |
| `stellar-verification-error` | An error | The API routes above, for every non-2xx answer. A result root's errors are whatever its host returns |

## Reading versions

A producer writes exactly the fields of its `schema_version`. A reader must allow fields it does not know
and read an unknown `status` as `unverified`, so that a document from a later minor version still reads.
A new major version is a different format.

## Status object

One entry per verifier in `source_code_verifications`. A field appears only when the fact it reports
was established: `rebuilt_hash` only on `mismatched`, and an `unverified` entry is exactly a verifier and
a status.

::: details `verified`
<<< @/../../../docs/results-sep/examples/results/status/200-verified.json
:::

::: details `mismatched`
<<< @/../../../docs/results-sep/examples/results/status/200-mismatched.json
:::

::: details `202`, a verification in flight
<<< @/../../../docs/results-sep/examples/results/status/202-pending.json
:::

`results_urls` points to the full report, which is stored under its own SHA-256 and never changes. The
`sha256` on that entry is how you check the report's bytes.

## Aggregate

Every listed verifier's entry for one Wasm hash, side by side. `agreement` describes the entries
without deciding between them, and `unavailable_verifiers` names the verifiers whose latest read
failed; see [Trust model](../introduction/trust-model.md).

::: details `disputed`
<<< @/../../../docs/results-sep/examples/aggregation/aggregate/200-disputed.json
:::

::: details A verifier that could not be read
<<< @/../../../docs/results-sep/examples/aggregation/aggregate/200-unavailable-peer.json
:::

## Bulk-load page

Pass back `cursor` from the previous page exactly as you received it; it is `null` once a page holds
fewer records than `limit`. A
record can come back on a later page with a later update time, so store records by `wasm_hash` and
overwrite.

::: details A verifier's first page
<<< @/../../../docs/results-sep/examples/results/page/200-first-page.json
:::

::: details An aggregator's first page
<<< @/../../../docs/results-sep/examples/aggregation/page/200-first-page.json
:::

## Trusted Verifiers List

::: details An aggregator's list
<<< @/../../../docs/results-sep/examples/aggregation/verifiers/200-verifiers.json
:::

## Error

Four fields are always present. Read `error`, a stable code, and show `message` to a person; a
response may carry more fields beside them. The codes are listed in [Errors](./errors.md).

<<< @/../../../docs/results-sep/examples/results/error/404-not-found.json

## The Results SEP

The formats are written up as two Stellar ecosystem proposal drafts: one for a verifier's results, one
for aggregation. Each schema's `$id` names its format; it is not a URL the file is served from. To
validate, download the schema files below and register each under its `$id`. The files describe
version 1.0 exactly: their objects and vocabularies are closed, so relax both as described in
[Reading versions](#reading-versions), or a later minor version will fail validation.

<p v-if="sourceIsPublic">Read both proposals in full:
<a href="/docs/specifications/verification-results">Verification results</a> and
<a href="/docs/specifications/aggregation">Aggregation</a>.</p>

| Schema file | `schema` |
| --- | --- |
| <a href="/docs/schemas/stellar-verification-status-1.0.schema.json"><code>stellar-verification-status-1.0.schema.json</code></a> | `stellar-verification-status` |
| <a href="/docs/schemas/stellar-verification-page-1.0.schema.json"><code>stellar-verification-page-1.0.schema.json</code></a> | `stellar-verification-page`, a verifier's page |
| <a href="/docs/schemas/stellar-verification-page-aggregated-1.0.schema.json"><code>stellar-verification-page-aggregated-1.0.schema.json</code></a> | `stellar-verification-page`, an aggregator's page |
| <a href="/docs/schemas/stellar-verification-aggregate-1.0.schema.json"><code>stellar-verification-aggregate-1.0.schema.json</code></a> | `stellar-verification-aggregate` |
| <a href="/docs/schemas/stellar-trusted-verifiers-list-1.0.schema.json"><code>stellar-trusted-verifiers-list-1.0.schema.json</code></a> | `stellar-trusted-verifiers-list` |
| <a href="/docs/schemas/stellar-verification-error-1.0.schema.json"><code>stellar-verification-error-1.0.schema.json</code></a> | `stellar-verification-error` |
