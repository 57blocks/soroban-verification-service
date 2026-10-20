# Changelog

Notable changes to this project. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

**What is versioned here.** The `soroban-verification-client` package, the public HTTP surfaces of `verification-svc`
and `query-svc`, and the published result format. The services themselves are deployed continuously
rather than released, so a change with no effect on any of the four may not appear below.

**How a version comes to exist.** The git ref decides it: `main` mints a `dev` prerelease, a tag
mints a release, and the `latest` dist-tag never holds a prerelease.

## [Unreleased]

### Changed

- **The query API refuses a malformed Wasm hash.** `GET /api/query/v1/wasms/{wasm_hash}` and its `.json`
  alias answer `400` with `invalid_wasm_hash` for anything that is not 64 hexadecimal characters, rather
  than `200` with `no_data` and the input echoed back as `wasm_hash`. Either case is still accepted.
- **Breaking: the SDK refuses a malformed Wasm hash before any request.** `newClient().registry.byHash`
  and `.statusObject`, and `statusObjectUrl`, throw `InvalidWasmHashError`;
  `newHostedClient().registry.byHash` throws `QueryApiError` with code `invalid_wasm_hash` and status `0`.
  Both used to answer `no_data` for such a hash. A peer-direct aggregate now reports the hash lowercased.

### Fixed

- The published `package.json` no longer carries the repository's own `devDependencies` and `scripts`.
- The SDK README's links resolve wherever it is rendered, not only on GitHub.

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
