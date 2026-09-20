# E2E fixture kit

This directory contains the reproducible inputs for the E2E suite's fixtures, referenced by
`test/integration/README.md`. Large generated archives and fetched Wasm files are written to
`artifacts/e2e-fixtures/`, which is intentionally ignored by Git.

## Generate the local data set

From the repository root:

```bash
bash test/fixtures/e2e/generate-fixtures.sh
```

The generator downloads the byte-pinned source archive already used by the testnet verification
fixture, verifies its SHA-256, fetches the corresponding deployed Wasm, and creates:

- canonical, mismatch, compiler-error, private-canary, egress, toolchain-selector, planted-Wasm,
  and build-script-planted source archives;
- 200 distinct compilable mismatch candidates for `F-BULK`;
- path-traversal and symlink-escape tarballs;
- `manifest.ndjson`, containing the exact bytes and SHA-256 of every generated archive.

Entry-count and expanded-size boundary archives require deployment values:

```bash
SCVS_FIXTURE_TAR_ENTRY_LIMIT=<policy value> \
SCVS_FIXTURE_UNCOMPRESSED_LIMIT=<policy value> \
bash test/fixtures/e2e/generate-fixtures.sh
```

Do not substitute guessed limits. The QA cases mark these values with the deployment-dependent
marker because the TRD does not define them.

Validate the generated set with the same local toolchain pair recorded by the existing
`cli-legacy` target:

```bash
bash test/fixtures/e2e/validate-local.sh
```

This performs real builds. It proves the canonical archive reproduces the deployed hash, the
private-canary archive has distinct source bytes but reproduces the same Wasm, mismatch and bulk
candidates compile to different hashes, both planted-byte attacks coexist with a real compiler
output, and the compiler-error fixture fails for the intended reason.

Build the purpose-built contract Wasm files with the pinned official image and source archive:

```bash
bash test/fixtures/e2e/build-purpose-contracts.sh
```

This requires Docker. It verifies the public source archive's SHA-256 against `registry.yaml`, then
builds source-backed fixtures from that extracted archive. It also builds the old and new versions of
the upgrade fixture and records a separate source archive for each version.

The stable `F-58` Wasm (`f-58-complete.wasm`) is part of the script's `all` scope. For that one fixture,
`prepare-ci-sources.sh` is optional because `build-purpose-contracts.sh` downloads the canonical
archive when it is absent; the prepare step is required for the complete CI corpus (including the
generated ZIP, adversarial, mismatch, and retention archives).

The host-side CLI is used only for `contract info meta`. Every build runs inside the digest-pinned
image, where cli-58 recipes are written explicitly with `--meta`; a released CLI is sufficient. The
script selects a compatible CLI by capability, including a cargo-installed `~/.cargo/bin/stellar`
when an older Homebrew binary appears first on PATH. Override detection explicitly when needed:

```bash
SCVS_FIXTURE_STELLAR_BIN=/path/to/stellar \
bash test/fixtures/e2e/build-purpose-contracts.sh
```

During F-UPG iteration, set `SCVS_FIXTURE_BUILD_SCOPE=upgrade` to skip the unchanged static
fixtures and the slower cli-58 recipe builds.

To prepare only the dedicated mismatch target, without rebuilding F-58, F-NONE, or the upgrade
fixtures, use:

```bash
SCVS_FIXTURE_BUILD_SCOPE=mismatch \
bash test/fixtures/e2e/build-purpose-contracts.sh
```

To prepare only the two chain-recorded image-policy fixtures, use:

```bash
SCVS_FIXTURE_BUILD_SCOPE=image-policy \
bash test/fixtures/e2e/build-purpose-contracts.sh
```

To prepare only the multi-package contract-b fixture and its deterministic source archive, use:

```bash
SCVS_FIXTURE_BUILD_SCOPE=multi-package \
bash test/fixtures/e2e/build-purpose-contracts.sh
```

Dev CI first generates the full source archive corpus, then uses `SCVS_FIXTURE_BUILD_SCOPE=ci` to
build F-LEG-1, F-LEG-3, and F-58-PRIV, followed by the two F-UPG source archives. It supplies
`SCVS_FIXTURE_BUILD_VARIANT` so F-LEG-3 contains a run-specific inert string and therefore has a
fresh Wasm hash. A new contract id alone is insufficient because Registry status is keyed by Wasm
hash, not contract id. `SCVS_FIXTURE_OUTPUT_ROOT` can redirect generated build/deployment evidence
to a temporary directory when validating the scripts locally.

`E2E-SRC-05/cli_58_private_upload` has a dedicated local command. After storing a funded local
Stellar **key alias** in `SCVS_FIXTURE_TESTNET_ACCOUNT` and setting the E2E deployment URLs in
`test/integration/.env`, run:

```bash
pnpm --filter @scvs/e2e-tests run test -- \
  cases/src/src-visibility.spec.ts \
  -t "uses upload_id instead of the chain's source_uri"
```

Selecting this case resolves a released Stellar CLI for metadata inspection unless
`SCVS_FIXTURE_STELLAR_BIN` names a compatible one. The command then creates a run-scoped
private cli-58 archive and Wasm inside the digest-pinned build image, deploys it to testnet, generates
and validates a run-local inventory, then executes only that E2E case. It deliberately leaves public deployment evidence and generated
files below `artifacts/e2e-fixtures/local/`; no committed fixture inventory or registry entry is
changed.

Run the normal upgrade lifecycle through the same E2E entrypoint:

```bash
pnpm --filter @scvs/e2e-tests run test -- \
  cases/upg/upg-normal-lifecycle.spec.ts
```

It builds both versioned source archives, deploys v1 at a run-scoped address, upgrades only that
address to v2, and records its separate inventory below `artifacts/e2e-fixtures/upgrade/`.

Purpose-built Wasm files can be deployed to testnet with an explicit local key alias:

```bash
SCVS_FIXTURE_TESTNET_ACCOUNT=<stellar-key-alias> \
bash test/fixtures/e2e/deploy-testnet.sh
```

## Performance Target Pool

PERF-01 and PERF-02 use the persistent `performance_verified` pool committed in
`test/integration/fixtures/e2e-fixtures.dev.json`. Renew its testnet contract addresses through the
normal fixture build/deploy workflow when they expire, validate the resulting inventory, then promote
the public target records into the committed pool. Do not run a local workload concurrently with CI or
another local workload against that pool.

Prepare the upgradeable testnet fixture after the Wasm build:

```bash
SCVS_FIXTURE_TESTNET_ACCOUNT=<stellar-key-alias> \
bash test/fixtures/e2e/prepare-upgrade-testnet.sh
```

The script deploys v1, installs v2, initializes the upgrade authority to the public address behind
the alias, and leaves the contract on v1. Tests can move it in either direction without redeploying:

```bash
SCVS_FIXTURE_TESTNET_ACCOUNT=<stellar-key-alias> \
bash test/fixtures/e2e/set-upgrade-testnet-version.sh new
```

Use `old` instead of `new` to reset it. Every transition fetches the current Wasm and checks the
observed hash before recording the transition.

Before deployment, rebuild both source archives independently and compare them with the recorded
Wasm hashes:

```bash
bash test/fixtures/e2e/validate-upgrade-sources.sh
```

Extend both contract-instance and contract-code TTLs for all recorded testnet deployments:

```bash
SCVS_FIXTURE_TESTNET_ACCOUNT=<stellar-key-alias> \
bash test/fixtures/e2e/extend-testnet-ttl.sh
```

The default extension is 500,000 ledgers and can be changed with
`SCVS_FIXTURE_TTL_LEDGERS`. The resulting live-until ledgers are recorded under the ignored artifact
directory.

## Public testnet candidates

`registry.yaml` also records a small supplemental corpus of real public testnet contracts discovered
from StellarExpert and public project repositories:

- Stellaroid Earn, whose deployed Wasm includes `source_repo=github:Iron-Mark/Hackathon-Stellaroid_Earn`;
- Stellaroid-2026, whose README names a reference testnet contract and source workspace;
- Soroban Smart Block Explorer, whose README names a testnet contract and source workspace.

These are intentionally `candidate`, not `ready`. They prove that the fixture kit is not limited to
the repository's purpose-built contracts, but none has a complete on-chain SEP-58 recipe or an
independent exact rebuild recorded here yet. Use them for exploratory coverage, metadata parsing,
and future recipe-composition work. Do not replace the deterministic ready fixtures with these
contracts until the registry records a submitted recipe, build environment, and exact hash match.

The StellarExpert contract-list cursor returned repeated pages or `NaN` self-loop pagination during
the 2026-08-03 scan, so the registry does not claim a complete testnet rescan.

Re-check those candidates with:

```bash
bash test/fixtures/e2e/validate-public-testnet-candidates.sh
```

The script writes `public-testnet-candidates.ndjson` and the downloaded public source archives under
the ignored artifact directory.

## Validate public mainnet candidates

Run the public-candidate check independently of a configured Stellar RPC:

```bash
bash test/fixtures/e2e/validate-public-candidates.sh
```

It checks StellarExpert's live contract record, downloads the exact mainnet Wasm, hashes and parses
it locally, confirms the source tag still resolves to the recorded commit, and downloads a local
copy of that commit. The mainnet contract-list cursor repeated a page during preparation, so
`registry.yaml` names this limitation and does not describe the check as a complete mainnet scan.

Reflector Pulse is a ready public `F-LEG-1-MAINNET` fixture. The fixed source archive and recorded
recipe rebuilt to the observed mainnet Wasm hash in the verifier's composed Stellar CLI 27.0.0 / Rust
1.97.1 image; rerun `validate-mainnet-reflector-rebuild.sh` to repeat that evidence. The same contract
also supplies the recipe-free `F-MAINNET-READ-ONLY` view for non-mutating `E2E-NET-01` rows. Mainnet
F-58 and F-UPG remain explicit blockers; preparing those by deployment requires an approved funded
mainnet signer.

## Registry states

- `ready`: every external dependency needed by the fixture has been checked.
- `candidate`: the chain object is valid, but one or more E2E preconditions still need validation.
- `blocked`: a named prerequisite is missing, such as a composed image or a controllable deployment.

An existing contract is not ready merely because it resolves. The registry must also state the
observed Wasm hash, metadata class, toolchain pair, source hash, and image availability.

## Ordering

The integration harness gives submitted recipes a run/case scope, so a prior run cannot satisfy a
case through Rule B or C. F-LEG-3 also owns a target hash that no matching-source case verifies;
therefore mismatch cases do not depend on running before F-LEG-1. `F-BULK` uses candidates whose
compiled constant differs from the deployed contract so none can accidentally become a matching
source.
