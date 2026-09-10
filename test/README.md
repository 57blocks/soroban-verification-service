# Tests

Test areas:

- SEP-58 metadata parsing;
- source retrieval modes;
- private tarball SHA-256 verification;
- image trust policy;
- sandbox timeout and resource limits;
- byte-for-byte Wasm comparison;
- mismatch diagnostics;
- result publishing;
- Public Query API aggregation;
- SDK schema validation;
- source deletion and log redaction.

## Manual E2E Fixtures

- `e2e/testnet/`: real Stellar testnet fixture for metadata-backed
  verification and a retroactive/manual-evidence example.

The testnet fixture is manual because it depends on network access, Docker
image pulls, and the current state of Stellar testnet. No `test:m1` script
exists in the root `package.json`; nothing currently runs this fixture other
than by hand.

## M2 Aggregation Fixtures

- `fixtures/verifiers/`: two local verifier result roots plus a trusted
  verifier list.
- `fixture-verifier-a` returns `verified`.
- `fixture-verifier-b` returns `mismatch` for the same target.

These fixtures are consumed by `clients/sdk`'s own test suite
(`pnpm --filter @scvs/sdk run test`) and `query-svc`'s aggregation tests
(`pnpm --filter @scvs/query-svc run test`). The root `package.json` does now define a few
`test:*` scripts — `test:smoke` (runs `@scvs/e2e-tests`' smoke suite) and
`test:perf:locust`/`test:perf:locust:open` (the performance harness under
`test/performance/`) — but neither reads these M2 aggregation fixtures.

## Directory Layout

This directory was renamed from `tests/` to `test/` to match the target
monorepo scaffold. In addition to the areas above, it now also reserves:

- `integration/`: `@scvs/e2e-tests`, the black-box suite that drives a real
  deployment through its public surfaces only — see `integration/README.md`.
  It is gated behind `SCVS_E2E=1` and skips, naming what is missing, without
  it. The LocalStack + Testcontainers tier this directory originally reserved
  was never written; if it is built later it belongs beside that package
  (`integration/localstack/`), not in place of it.
- `fixtures/malicious-tarballs/`: adversarial source-archive fixtures
  (path traversal, symlink escapes, zip bombs) for Builder extraction
  safety testing. The corpus itself lives elsewhere — see that
  directory's own README.
- `fixtures/sample-contracts/`: good-path sample Soroban contract source
  trees for build/verify testing. Four trees are present (added for the
  differential harness) — see `fixtures/sample-contracts/README.md`.

**`test/` is not a general-purpose pnpm workspace, by decision.** It holds
fixture data and documentation by default. The one named exception is the
cross-service public black-box package `integration/@scvs/e2e-tests`; no
service-owned or LocalStack/Testcontainers suite belongs here. Any other
suite that lands under `integration/` or `fixtures/malicious-tarballs/`
belongs inside the workspace package that exercises it (as the differential
harness and the malicious-tarball corpus already do). See this repository's
internal decision record on `test/` workspace membership for the full rationale.
