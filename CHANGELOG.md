# Changelog

Notable changes to this project. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

**What is versioned here.** The `soroban-verification-client` package, the public HTTP surfaces of `verification-svc`
and `query-svc`, and the published result format. The services themselves are deployed continuously
rather than released, so a change with no effect on any of the four may not appear below.

**How a version comes to exist.** The git ref decides it: `main` mints a `dev` prerelease, a tag
mints a release, and the `latest` dist-tag never holds a prerelease.

## [Unreleased]

### Security

The fixes for an external security assessment (OtterSec) and an internal re-review of them. Several
change what the verification API accepts; those are also listed under **Changed**.

- **A private upload needs its own secret.** `POST /api/verification/v1/uploads/source` returns an
  `upload_secret` beside the `upload_id`, once. A submission whose manifest names that `upload_id` must
  send the secret as the top-level `upload_secret`, or it is refused with `403` `upload_secret_invalid`.
  An upload's visibility is fixed by the first submission that creates a job; a later one asking for the
  other visibility is refused with `409` `upload_visibility_conflict`, and one whose upload has meanwhile
  expired or been used is refused with `400` `upload_not_found`. (#246)
- **A private submission's `source_uri` is no longer published.** The report's `source.source_uri` and the
  status object's `source_uri` are written only for a public submission. Republishing (the orchestrator's
  `publish-once`) rewrites earlier results without it and points each private job, and each public job that
  adopted a private job's verdict, at its rewritten report,
  which is then archived in its own right; the earlier reports stay in result storage, and copies already
  archived to Arweave cannot be withdrawn. (#243, #268)
- **A `source_uri` job proves it holds its source before it shares a rebuild.** Each job fetches its
  own URL and checks the declared `source_sha256` before attaching to a rebuild another submission
  started, and a source is published only from the publishing job's own copy. (#237, #255)
- **Build options can no longer reach the verifier's environment.** A `--env` without a value, and a
  `--env` naming a variable that starts with `SCVS_`, `AWS_`, `ECS_` or `DOCKER_`, are refused. (#238)
- **A contract upgraded during its build is not verified.** The job fails with
  `target_changed_during_build`, and any result is refused when the Wasm's own recorded
  `source_sha256` names another source (`source_archive_not_chain_recorded`). (#242)
- **The rebuild sandbox is isolated further:** its own uid, non-recursive binds, a Docker API gateway
  instead of the host's socket, no route to the instance metadata service, and a prefetch stage whose
  only way out is a proxy to an allowlist of hosts. (#239, #240, #244, #245, #247, #248, #249, #252,
  #253, #254)

### Changed

- **Breaking: a submission naming an `upload_id` must send `upload_secret`.** See **Security**. (#246)
- **Breaking: a compressed request body is refused.** Both public APIs answer `415`
  `content_encoding_unsupported` to a request whose `Content-Encoding` is anything but `identity`,
  before the body is read. (#236)
- **Breaking: a public submission's `source_uri` may not carry credentials.** A user name, a password or
  a credential-like query parameter (`X-Amz-Signature`, `X-Goog-Signature`, `sig`, `token`,
  `access_token`, `api_key` and similar) is refused with `400` `invalid_manifest`. (#243)
- **Breaking: a target that names a contract and a Wasm the contract does not run is refused** with `400`
  `target_wasm_not_deployed`. Submit the contract alone, or the Wasm hash alone. (#264)
- **Breaking: stricter build options.** A `--env` without a value, or naming a reserved prefix, is
  refused with `400` `policy_rejected`. A single-valued option given twice (`--package`,
  `--manifest-path`, `--profile`, `--out-dir`), the same `--env` name twice, or the same `--meta` key
  twice is refused with `400` `invalid_manifest`. A recipe recorded on chain that breaks either rule
  fails the job (`recorded_env_option_refused`, `recorded_build_option_repeated`). (#238, #241)
- **Rebuilds are keyed on `bldopt` in the order submitted,** and a published result records the build
  options of the rebuild that ran. (#241)
- **New failure reasons:** `target_changed_during_build` and `source_archive_not_chain_recorded` (#242),
  and `recorded_env_option_refused` and `recorded_build_option_repeated` (#238, #241).
- **A source fetch that met a transient fault is retried.** A job whose source URL timed out, dropped
  the connection, or answered `408`, `429` or `5xx`, or whose staging copy failed, now fails as the
  retryable `internal_error` with the specific reason code (`source_uri_not_materialized`,
  `source_stage_copy_failed`) rather than as `source_unreachable`. The fetch's deadline now covers
  reading the body. (#256)

- **What a `verified` result claims is stated where it is read.** The documentation, the results SEP's
  Security Concerns and the console now say that a result covers the complete source, including the
  build scripts, procedural macros and dependencies that run during the build and can shape the bytes,
  and that no check on the output can rule that code out. They also say that only a public source can be
  reviewed by others, and that unless the contract records its `source_sha256`, anyone can submit a
  source that builds to its bytes and a newer `verified` replaces an older one.
- **The console's rebuild card says whose source it is.** It states whether the contract binds the
  source on chain by its hash, read from the report's `source.chain_source_sha256`, and whether the
  source is public.
- **The query API refuses a malformed Wasm hash.** `GET /api/query/v1/wasms/{wasm_hash}` and its `.json`
  alias answer `400` with `invalid_wasm_hash` for anything that is not 64 hexadecimal characters, rather
  than `200` with `no_data` and the input echoed back as `wasm_hash`. Either case is still accepted.
- **Breaking: the SDK refuses a malformed Wasm hash before any request.** `newClient().registry.byHash`
  and `.statusObject`, and `statusObjectUrl`, throw `InvalidWasmHashError`;
  `newHostedClient().registry.byHash` throws `QueryApiError` with code `invalid_wasm_hash` and status `0`.
  Both used to answer `no_data` for such a hash. A peer-direct aggregate now reports the hash lowercased.

### Fixed

- **The direct client no longer relays an entry under another verifier's identity.** From each result
  root, `registry.byHash` now relays only the entry whose `verifier.url` names that root, or the
  first entry when none names a URL, as the hosted aggregator already did. Before, it relayed every
  entry with the `verifier` the document claimed, so a listed verifier could publish results shown
  under another verifier's result root. A document holding no entry of its own counts as no result,
  not as an unavailable verifier.
- The published `package.json` no longer carries the repository's own `devDependencies` and `scripts`.

## [0.1.0] - 2026-10-20

The first public release. The project was developed privately before this point, and its history was
not carried across — see [`AUTHORS`](AUTHORS) for the people who wrote it.

### Added

- **Source verification for Soroban contracts.** Submit a deployed contract by contract ID or Wasm
  hash together with its source; the service rebuilds it in an isolated sandbox using the build
  environment the deployed contract itself records, and compares the rebuilt Wasm byte for byte.
- **A published, content-addressed result tree**, mirrored to permanent storage, readable without any
  client — the format is specified in [`docs/results-sep/`](docs/results-sep/) as a Stellar ecosystem
  proposal rather than as a private convention.
- **Cross-verifier aggregation** over a Trusted Verifiers List, so a consumer can ask what every
  verifier says about a Wasm rather than what one does.
- **A TypeScript SDK** (`soroban-verification-client`) for both the query and aggregation surfaces.
- **A submission and results console.**
- **Composed build environments** for contracts whose recorded toolchain has no published official
  image, built from digest-pinned official components.

[Unreleased]: https://github.com/57blocks/soroban-verification-service/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/57blocks/soroban-verification-service/releases/tag/v0.1.0
