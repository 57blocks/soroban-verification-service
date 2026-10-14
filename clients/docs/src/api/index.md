# API reference

Two HTTP APIs, both JSON over HTTPS, with no account and no key.

| API | Base path | Use it to |
| --- | --- | --- |
| Submission API | `/api/verification/v1` | Check a contract, submit it, follow the job, and read this verifier's own results |
| Query API | `/api/query/v1` | Read every listed verifier's results for a Wasm hash or a contract |

Paths are relative to the host serving these pages, and the examples on the operation pages use it. A
verifier that runs without an aggregator serves only the Submission API.

## Authentication

There is none. The only credential is the build-log token: a submission that creates a job answers with
`build_log_token`, once, and reading or deleting that job's build log takes it in the
`X-Build-Log-Token` header.

## Errors

A refused request answers with an HTTP error status and an error body. Branch on its `error` code and
the status, never on `message`. The codes, and the outcomes of a job that fails after it was accepted,
are listed in [Errors](./errors.md).

## Rate limits

Limits are counted per caller and per route, over one-minute windows. A request past a limit is
refused with `429` and `rate_limited`.

| Route | Default limit per minute |
| --- | --- |
| `GET /api/verification/v1/verifications/{job_id}` | None |
| `POST /api/verification/v1/verifications`, `POST /api/verification/v1/uploads/source` | 6 |
| `POST /api/verification/v1/preflight` | 18 |
| The build-log routes, `GET` and `DELETE` together | 18 |
| Opening `GET /api/verification/v1/verifications/{job_id}/events` | 12 |
| `GET /api/verification/v1/wasms` and `GET /api/verification/v1/wasms/{wasm_hash}.json` | 600 |
| `GET /api/verification/v1/legal` | 60 |
| The OpenAPI documents | 600 |
| The health routes | None |
| `GET /api/query/v1/contracts/{network}/{contract_id}` | 60 |
| The other Query API routes | 600 |

Each operator sets its own limits, so treat these as defaults, not promises: read the `429` and back off.

- The routes whose limit is 600 or 60, other than the OpenAPI documents, answer with `X-RateLimit-Limit`, `X-RateLimit-Remaining` and
  `X-RateLimit-Reset`, and a `429` from them carries `Retry-After` in seconds.
- The submit, upload, preflight, build-log and stream-opening limits are counted in fixed clock-minute
  windows. Their `429` carries no `Retry-After`, and any `X-RateLimit-*` headers on those routes describe
  a looser ceiling of 60 a minute, not these limits. Wait for the next minute.

Resolving a contract address reads the ledger on every request, which is why that route has the tighter
limit. To enrich many contracts, resolve each address once and read by Wasm hash from then on.

## Pagination

The bulk-load routes, `GET /api/verification/v1/wasms` and `GET /api/query/v1/wasms`, return pages:

| Parameter | Values | Default |
| --- | --- | --- |
| `order` | `asc` or `desc` | `asc` |
| `limit` | 1 to 200 | 100 |
| `cursor` | The `cursor` of the previous page, passed back unchanged | The first page |

The next `cursor` is `null` when a page holds fewer records than `limit`, so a last page that is exactly
full is followed by one empty page. Treat the cursor as opaque. A record can come back on a later page
with a later update time, so store records by `wasm_hash` and overwrite.

## Size limits

| What | Default limit |
| --- | --- |
| An uploaded source archive | 50 MiB |
| A JSON request body | 100 KiB, fixed |

A JSON body over the limit is currently refused with `500` and `internal_error`.

## Caching

The routes that create or name a job — submit, job status, build log and upload — answer with
`Cache-Control: no-store`. `GET /api/verification/v1/legal` carries an `ETag`, the SHA-256 of the bytes
served, and answers `304` to a matching `If-None-Match`.

## Calling from a browser

The Submission API accepts requests from any origin, and the Query API does by default. From a browser on
another origin, the Submission API allows `GET` and `POST`, so deleting a build log needs a server-side
client. Browser code on another origin cannot read `X-RateLimit-*`, `Retry-After`, `ETag`, `Deprecation`
or `Sunset`.

## Versioning

The version is part of every path: `v1`. Every result document carries `schema` and `schema_version`;
see [Result documents](./result-documents.md).

Three routes are deprecated aliases. They answer with `Deprecation: true` and a `Sunset` header, and are
removed from 1 December 2026:

| Deprecated | Use instead |
| --- | --- |
| `GET /api/verification/v1/wasms.json` | `GET /api/verification/v1/wasms` |
| `GET /api/query/v1/wasms.json` | `GET /api/query/v1/wasms` |
| `GET /api/query/v1/wasms/{wasm_hash}.json` | `GET /api/query/v1/wasms/{wasm_hash}` |

## OpenAPI documents

The operation pages are generated from each API's own OpenAPI document, which you can also fetch:
`/api/verification/v1/openapi.json` and `/api/query/v1/openapi.json`.
