# Changelog

Notable changes to this project. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

**What is versioned here.** The `soroban-verification-client` package, the public HTTP surfaces of `verification-svc`
and `query-svc`, and the published result format. The services themselves are deployed continuously
rather than released, so a change with no effect on any of the four may not appear below.

**How a version comes to exist.** The git ref decides it: `main` mints a `dev` prerelease, a tag
mints a release, and the `latest` dist-tag never holds a prerelease.

## [Unreleased]

The first public release, to be published as `0.1.0`. The project was developed privately before this
point, and its history was not carried across — see [`AUTHORS`](AUTHORS) for the people who wrote it.

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
