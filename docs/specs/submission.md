# Submission

As built. See `Verified by:` on each claim.

## Surface

Every route below is under `/api/verification/v1`. Free, no accounts, no KYC, HTTPS only.

| Method | Path | Purpose |
| :---- | :---- | :---- |
| `POST` | `/preflight` | Contract metadata, dedup status, missing fields, suggested recipe |
| `POST` | `/verifications` | Submit a job (`dry_run` optional, default `false`) |
| `GET` | `/verifications/{job_id}` | Status and result |
| `GET` | `/verifications/{job_id}/events` | Server-sent progress |
| `GET` | `/verifications/{job_id}/log` | Redacted build output, every terminal outcome including failure |
| `POST` | `/uploads/source` | Upload target; carries the public-declaration flag |
| `GET` | `/wasms` | Reads the published bulk-load stream: `jobs.published_updated_at` and the same documents `orchestrator-svc` publishes |
| `GET` | `/wasms/{wasm_hash}.json` | Reads the published result root: the same bytes at `wasms/<hash>.json`, plus `202` while a verification for that hash is queued or running |

Field-level request/response shapes: [`docs/submission-api-guide.md`](../submission-api-guide.md).
`GET /contracts/{network}/{contract_id}` is served under `query-svc`'s own `/api/query/v1/` prefix
(`services/query-svc/src/modules/results/results.controller.ts`), a separate service from this one.

Both `/wasms` routes above give a consumer of this verifier's public HTTP surface a stable place to
poll or enumerate results without its own storage-backend or bucket-layout knowledge: verification-svc
fetches the same object the publisher wrote and returns it byte-identical, adding only the states a
static file cannot represent (`202` in flight, `404`/`503` for absent/unreadable storage).

Verified by: `services/verification-svc/src/modules/preflight/preflight.controller.ts`,
`services/verification-svc/src/modules/verifications/verifications.controller.ts`,
`services/verification-svc/src/modules/wasms/wasms.controller.ts`,
`services/verification-svc/src/modules/wasms/wasms.service.ts` (`storage.readText(wasmStatusKey(wasmHash))`),
`services/verification-svc/src/modules/bulk-load/own-bulk-load.controller.ts`

## Preflight

Read-only, never starts a build. Returns a submittable recipe when on-chain metadata is complete
(cli-58); returns what is missing when it is not (cli-legacy); reports `unsupported` before a job
exists when the class is out of scope (cli-none).

Reports dedup status: a `verified` result may already exist for the hash, or an identical rebuild
may be cached. Neither short-circuits a submission on its own — only an exact recipe repeat does,
and only after the target's current deployed hash is re-fetched and still matches.

Verified by: `test/integration/cases/sub/sub-01-recipe-completion.spec.ts`,
`test/integration/cases/dedup/dedup-01-idempotency.spec.ts`,
`test/integration/cases/dedup/dedup-03-05-rules.spec.ts`

## Synchronous rejection vs. job failure

A check decidable from the request alone is synchronous (`4xx`, no job row). A check needing the
ledger (deployed metadata) is a job failure in `preparing`. No job failure is ever published — an
unverified contract simply has no entry, because a negative claim this verifier did not establish
is not published.

`unsupported` and `policy_rejected` are disjoint: an image policy does not yet accept is
`unsupported`; a submitted option policy rejects is `policy_rejected`. `mismatched` is not in this
set — it is a published verdict, not a rejection.

Verified by: `test/integration/cases/sub/sub-04-05-image-policy.spec.ts`,
`test/integration/cases/sub/sub-09-failure-matrix.spec.ts`,
`test/integration/cases/sub/sub-09-unsupported-toolchain.spec.ts`

## Dry runs

`dry_run` (default `false`) builds, compares, and returns the verdict with its build log, and writes
nothing to the result root. Honoured or rejected, never silently ignored — a verifier not
implementing it must reject the request rather than publish what the submitter asked to keep
unpublished. Storage is not durable regardless of the declared visibility, since nothing is
published to reference.

Verified by: `test/integration/cases/sub/sub-18-dry-run.spec.ts`

## Source handling

Three retrieval modes: fetched by the verifier from a public `source_uri` (stored durably and
published to the result root at `sources/<source_sha256><ext>`, see
[Published results](published-results.md)); uploaded with a public declaration (same); uploaded
without one (not stored — only the hash is retained, bytes deleted at job termination on every path
including failure).

The upload route admits gzip (`.tar.gz`, `.tgz`, `.gz`) and zip archives, decided from file bytes,
never from a client-supplied filename — and the console's picker applies that same rule, so a name
a browser mangled on a second download (`archive.tar(2).gz`) is not refused before it is read.
An archive whose only file is a single top-level member (directories and `__MACOSX`, `._*` and
`.DS_Store` droppings aside) is treated as a container: that member must itself be an archive the
verifier reads, and it is unwrapped, up to four levels deep. The innermost archive is what gets
hashed (as `canonical_sha256`), built and published. Any other archive, including a zip of a
source tree, is extracted directly. For a contract that records a `source_sha256` on-chain, an
archive that does not hash to it is rejected at submit, not silently rebuilt or substituted.

Source visibility (`public` / `private` / `unavailable`) is reported independently of the verdict. A
verdict is never downgraded because source became unavailable later, and `private` is never
displayed as "missing source" — it is a legitimate, labelled outcome.

Stored source is addressed by `source_sha256`, never by Wasm hash — one hash can accumulate one
verified source plus several mismatched candidates, and addressing by hash would make "which
source" ambiguous.

Verified by: `test/integration/cases/src/src-06-verified-source-link.spec.ts`,
`test/integration/cases/src/src-12-adopted-public-resubmission.spec.ts`,
`test/integration/cases/sep55/sep55-01-positive-observation.spec.ts`,
`test/integration/cases/sep55/sep55-03-discriminator.spec.ts`,
`services/builder/test/archive-extraction.spec.ts`,
`services/builder/test/materialise-canonical-archive.spec.ts`,
`packages/storage-layout/src/keys.ts`

## Upload safety

Archives are checked for path traversal, symlinks, entry count, and uncompressed size before
extraction. Source bytes are checked against `source_sha256` at each hand-off, and which code a
mismatch carries depends on where it is caught:

- An upload whose hash, computed when it was received, differs from `manifest.source_sha256` is
  refused at submit with `400 source_hash_mismatch`; no job is created.
- A `source_uri` whose fetched bytes do not hash to the declared `source_sha256` fails the job
  before dispatch with reason `source_unreachable` (code `source_hash_mismatch`).
- Inside the builder, a staged archive that does not hash to `source_sha256` is refused before the
  build command runs, and a sandbox report whose source hash disagrees with the recorded one is
  refused before anything is published. Both carry `source_sha256_mismatch`, classed `build`, so
  the job ends `build_failed`.

Verified by: `test/integration/cases/sec/sec-archives.spec.ts`,
`services/verification-svc/test/upload-format-gate.spec.ts`,
`services/verification-svc/test/submit-upload-check.spec.ts`,
`services/orchestrator-svc/test/source-ref-dispatch-policy.spec.ts`,
`services/builder/test/fetch-source.spec.ts`,
`packages/core/src/rebuild-error-code.ts`

## Build-option validation

`bldopt` is validated then replayed equivalently — never silently dropped. A path option is
normalised and confirmed to resolve inside the mounted source tree; a value failing validation fails
the submission with `policy_rejected`, not a silent substitution. In-source toolchain selectors
cannot change the toolchain; toolchain acquisition is driven only by trusted image-class
configuration, never by archive content.

Verified by: `test/integration/cases/sub/sub-13-bldopt.spec.ts`,
`test/integration/cases/sec/sec-toolchain-selector.spec.ts`

## Abuse control

Submission routes (`preflight`, `verifications`, `uploads/source`) carry stricter rate-limit
thresholds than read routes. No accounts, no KYC — quotas are the substitute for authentication, not
a step toward it. A throttled request returns `rate_limited`, not an opaque body. There is no
on-demand enqueue from a `GET`.

The public read routes — the bulk-load stream and the per-hash status object — carry a per-caller
read quota of their own, wide enough for an aggregator paging the stream, and never spend the write
path's budget. The OpenAPI document and its Swagger UI are registered on the HTTP adapter, where no
route guard runs, so middleware covers them on the same ceiling under a separate counter. Only health,
job status and the progress stream are exempt: a submitter polling its own job is never refused.

Verified by: `test/integration/cases/sec/sec-surface-and-quota.spec.ts`,
`services/verification-svc/test/read-quota.spec.ts` (the public read routes carry a quota, the
documentation surface, throttled outside the guard chain)

## There is no trusted-image admin surface

No runtime API adds, removes, or lists a trusted build image. What this verifier trusts is fixed at
deploy time: an official image recognised by a rule in source code and changed through review, or an
environment this verifier composes itself from pinned official components
([rule 16 of `docs/invariants.md`](../invariants.md)). Trust in a single image digest of either kind
is withdrawn the same way, by listing it in `DENIED_IMAGE_DIGESTS` beside that rule. A contract whose
recorded image cannot be resolved to a trusted environment is `unsupported` — never verified on an
operator's say-so.
`policy.json` is published from configuration at process start and has no runtime mutation path.

Verified by: `test/integration/cases/sub/sub-04-05-image-policy.spec.ts`

## Redaction

The build log is redacted for credentials, tokens, upload targets, and local paths, and is available
for every terminal outcome including failure. A published field carries nothing the submitter did
not already supply: upload targets, storage keys, and internal paths never appear in a published
result; non-public source bytes are never written durably at all.

Verified by: `test/integration/cases/sub/sub-10-build-logs.spec.ts`,
`services/orchestrator-svc/src/modules/source-resolution/source-resolution.service.ts`
(`deleteObject` on the non-public path)

## Submit response status is a closed set

`POST /verifications` answers with `queued` or `incomplete` — never a job's internal status, and
never more than these two values. A rejection is the error envelope on a 4xx/5xx, carrying no
`status` key.

Verified by: `services/verification-svc/src/modules/verifications/submit.dto.ts`,
`test/integration/cases/sub/sub-01-recipe-completion.spec.ts`

## Error contract

Errors return `{schema, schema_version, error, message}` with stable machine-readable codes, defined
once in `@scvs/core` and shared by both public services. Clients branch on `error` and tolerate
unrecognised codes. `network_passphrase` is an optional, non-semantic hint — it never changes a
result and its absence is never a rejection.

Verified by: `packages/core/src/error-envelope.ts`,
`test/integration/cases/api-contract/`

## The developer-facing interface

The web console is the shipped submission flow: preflight, recipe completion, upload with the public
declaration, progress, verdict, and build log — including on failure. No CLI helper ships; the
published API and SDK (Node-compatible) are sufficient for non-interactive/CI use.

Verified by: `test/integration/cases/web/`, `test/integration/cases/sdk/`
