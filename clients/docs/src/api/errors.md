# Errors

Things go wrong in two places. A **request** can be refused, with an HTTP error status and an error
body. A **job** that was accepted can fail later; its status says so, and a code names the cause.

## The error body

Every refused request answers with the same envelope:

| Field | Always | Meaning |
| --- | --- | --- |
| `schema` | Yes | `stellar-verification-error` |
| `schema_version` | Yes | `1.0` |
| `error` | Yes | A stable code. Branch on this |
| `message` | Yes | Text for a person. It can change; never parse it |
| `status_code` | Most routes | The HTTP status again. `GET /api/verification/v1/wasms/{wasm_hash}.json` leaves it out |
| `detail`, `reason` | Sometimes | More about the cause, where a route has it |

Some routes add their own fields, named below.

```json
{
  "schema": "stellar-verification-error",
  "schema_version": "1.0",
  "status_code": 400,
  "error": "upload_expired",
  "message": "upload_id 0f8b9c2e-3d4a-4b5c-8d6e-7f8091a2b3c4 has expired. Upload the source archive again.",
  "detail": "upload_id 0f8b9c2e-3d4a-4b5c-8d6e-7f8091a2b3c4 has expired. Upload the source archive again."
}
```

## Request errors

### Submission API

| `error` | HTTP | Routes | Meaning |
| --- | --- | --- | --- |
| `invalid_request` | 400 | Preflight, submit | The body is not valid: a field has the wrong type or value. On submit this includes an unknown network and a missing target |
| `invalid_network` | 400 | Preflight | The network is not `mainnet` or `testnet` |
| `missing_target` | 400 | Preflight | Neither `contract_id` nor `wasm_hash` was given |
| `not_found` | 404 | Preflight, submit without a manifest | The contract or Wasm hash was not found on that network |
| `chain_lookup_failed` | 502 | Preflight, submit without a manifest | The ledger could not be read, or the contract's metadata could not be parsed. `reason` says which |
| `terms_acceptance_required` | 400 | Submit | The verifier's terms are in force and `accepted_terms_version` is missing |
| `terms_version_outdated` | 400 | Submit | `accepted_terms_version` is not the version currently served by `GET /legal` |
| `invalid_manifest` | 400 | Submit | The manifest is malformed; `detail` names the field |
| `policy_rejected` | 400 | Submit | A `--manifest-path` outside the source, or, on a submit without a manifest, a build image named by tag rather than digest; `detail` says which |
| `unsupported` | 400 | Submit without a manifest | The contract names a build image this verifier does not accept; `detail` says why |
| `upload_not_found` | 400 | Submit | `upload_id` names no upload, or the upload expired and has been removed. Upload again |
| `upload_expired` | 400 | Submit | The upload's 30 minutes ran out and it has not been removed yet. Upload again |
| `source_hash_mismatch` | 400 | Submit | `source_sha256` differs from the hash computed when the archive was uploaded |
| `source_archive_not_chain_recorded` | 400 | Submit | The contract records a `source_sha256` on chain, and the manifest's differs |
| `invalid_upload` | 400 | Upload | The body is empty |
| `source_archive_format_unsupported` | 400 | Upload | The bytes are neither a gzip tarball nor a zip file |
| `source_archive_too_large` | 413 | Upload | The archive is over the size limit, 50 MiB by default |
| `invalid_job_id` | 400 | Job status, build log, events | The job ID is not a UUID |
| `not_found` | 404 | Job status | No such job. A job that published nothing, whether it failed or was a dry run, is deleted 30 days after it was created, by default |
| `build_log_token_required` | 401 | Build log | No `X-Build-Log-Token` header |
| `not_found` | 404 | Build log | No such job, or the token is wrong; the two are indistinguishable on purpose. With the right token on a job that recorded no log, it adds `job_status` and `failure_reason` |
| `build_log_expired` | 410 | Read build log | The token is right, but the log is past its retention period. `expired_at` says when; after a delete it reads `1970-01-01T00:00:00Z` |
| `build_log_unavailable` | 502 | Read build log | The verifier could not read the log |
| `invalid_order`, `invalid_limit`, `invalid_cursor` | 400 | Bulk load | A pagination parameter is not valid; see [Pagination](./index.md#pagination) |
| `400_invalid_wasm_hash` | 400 | `GET /wasms/{wasm_hash}.json` | The hash is not 64 hexadecimal characters |
| `not_found` | 404 | `GET /wasms/{wasm_hash}.json` | Nothing is published for the hash, and nothing is in flight |
| `storage_unavailable` | 503 | `GET /wasms/{wasm_hash}.json` | The verifier could not read its result storage |
| `draining` | 503 | Submit, upload | The instance is shutting down. Retry |
| `abuse_check_unavailable` | 503 | Preflight, submit, upload, build log, events | The verifier could not check its rate limits. Retry |
| `rate_limited` | 429 | Most routes | A rate limit was reached; see [Rate limits](./index.md#rate-limits) |

### Query API

| `error` | HTTP | Routes | Meaning |
| --- | --- | --- | --- |
| `aggregation_unavailable` | 503 | All result routes | The aggregator has not finished its first pass over its verifiers. Wait and retry; do not read it as "no results" |
| `invalid_network` | 400 | By contract | The network is not `mainnet` or `testnet` |
| `invalid_contract_id` | 400 | By contract | The contract ID is not a valid contract address |
| `contract_not_found` | 404 | By contract | No contract at that address, or it does not run a Wasm |
| `address_resolution_failed` | 502 | By contract | The ledger could not be read to resolve the address |
| `invalid_order`, `invalid_limit`, `invalid_cursor` | 400 | Bulk load | A pagination parameter is not valid |
| `rate_limited` | 429 | Most routes | A rate limit was reached |

### Either API

| `error` | HTTP | Meaning |
| --- | --- | --- |
| `not_found` | 404 | No such route |
| `request_failed` | 4xx | The request could not be read, for example malformed JSON |
| `internal_error` | 500 | An unexpected fault on the server |

## Job outcomes

`GET /api/verification/v1/verifications/{job_id}` reports a job's `status`:

| `status` | Meaning | Published result |
| --- | --- | --- |
| `queued` | Accepted and not started yet, or waiting while its build environment is composed | — |
| `running` | In progress. `progress.step` names the stage, such as `building` or `comparing` | — |
| `verified` | The rebuilt Wasm matches the deployed one | `verified` |
| `mismatch` | The rebuilt Wasm differs from the deployed one | `mismatched` |
| `build_failed` | The build failed, timed out, or hit a fault on the verifier's side | None |
| `source_unavailable` | The source could not be fetched or read, or required inputs were missing | None |
| `policy_rejected` | A build option this verifier does not accept, or a recorded toolchain that can never be composed | None |
| `not_attempted` | The recorded build environment is one this verifier will not run: an image it does not accept, or a toolchain it cannot reproduce; see [Supported contracts](../introduction/supported-contracts.md) | None |

Every status but `queued` and `running` is final for the job as it stands. A `build_failed` caused by a
timeout or a fault on the verifier's side is retried automatically, up to three more times by default,
each shortly after the failure, so the job can go back to `queued`. A dry run ends as `verified` or
`mismatch` and publishes nothing.

## Failure codes

A failed job names its cause in `error`, and the same code in `result.reason`; `result.detail` adds a
sentence. When the build sandbox itself could not start, `error` can carry the container runtime's own
message rather than a code.

Several remedies below ask for a different archive. If the contract records `source_sha256` on chain,
the archive cannot change; report the failure to the verifier's operator instead.

<!--@include: ../../.vitepress/generated/failure-codes.md-->

### Other failure codes

These come from the steps around the build.

| Code | Job status | Meaning | What to do |
| --- | --- | --- | --- |
| `stellar_contract_fetch_failed` | `build_failed`, retried | The ledger could not be read. A contract that does not exist ends here too | Check the network and contract ID |
| `metadata_parse_failed` | `build_failed`, retried | The deployed Wasm's metadata could not be parsed | Report it to the verifier's operator |
| `missing_wasm_hash` | `source_unavailable` | No Wasm hash could be determined for the target | Give the Wasm hash directly |
| `image_not_digest_pinned` | `not_attempted` | The contract names a build image by tag, not by digest | — |
| `image_not_official_trusted` | `not_attempted` | The contract names a build image this verifier does not accept | — |
| `missing_toolchain_pair` | `not_attempted` | The contract does not record both `cliver` and `rsver` | — |
| `undated_nightly` | `not_attempted` | `rsver` names a nightly Rust toolchain without a date | — |
| `private_upload_unavailable`, `private_upload_incomplete` | `source_unavailable` | The upload is gone or incomplete | Upload again and resubmit |
| `rebuild_timeout` | `build_failed`, retried | The build ran past its time limit | — |
| `artifact_unreadable`, `artifact_schema_unsupported` | `build_failed` | The build's result could not be read | Report it to the verifier's operator |
| `worker_exception`, `environment_not_ready`, `comparison_not_available` | `build_failed`, retried | A fault on the verifier's side | None needed |
| `service_misconfigured` | `build_failed` | The verifier is missing a configuration value | Report it to the verifier's operator |

A failure to assemble a [composed build environment](../introduction/supported-contracts.md#cli-legacy)
ends as `policy_rejected` when the toolchain pair can never be composed, and as `build_failed` otherwise.
Neither is retried.
