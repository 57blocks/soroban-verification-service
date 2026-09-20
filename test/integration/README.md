# `@scvs/e2e-tests` — black-box end-to-end suite

Executable cases, run against a **real deployment** through its public surfaces only.

This package is a constrained exception for a cross-service public black-box E2E suite.
It is allowed to remain a workspace package because the cases cross verification-svc,
orchestrator-svc, and query-svc without importing or stubbing any owned component.

## What this is, and what it deliberately is not

A scenario counts as E2E only if it holds to all four of these conditions:

1. it enters through a public surface — HTTP endpoints, published static files;
2. **no component this project owns is stubbed** — not the services, not the packages, not the
   builder;
3. it uses a live network where on-chain state matters;
4. it observes a user-visible result.

Rule 2 is the one that shapes everything else. The plan's own justification: *"replacing an owned
component with a stub forces the assumptions on both sides of that boundary to agree, which hides
the defects these tests are meant to find."* So this suite boots no Nest application, opens no
database connection, and imports no `@scvs/*` package — not even for its type declarations, which
are restated in [`support/types.ts`](support/types.ts) precisely so that a field renamed on both
sides at once still shows up as a failure here.

That also means it is **not** a substitute for the per-service Jest suites. Those are where a rule
gets tested exhaustively and cheaply; this is where the wire formats between owned components are
tested at all. `services/orchestrator-svc/test/pipeline-e2e.spec.ts` sits in between — the real
state machine and real publishing, with the chain and Batch stubbed — and is the right place for
anything that needs to control what the chain says.

### A note on this directory's name

`test/integration/` was previously reserved, in its own README, for LocalStack + Testcontainers
tests against containerised AWS-compatible infrastructure. That work remains governed by the same rule:
such tests belong under the workspace package whose service they exercise. They must not become a
second package under this directory or inherit this cross-service exception.

## Running it

Nothing here runs by default. `pnpm run test` at the repository root enumerates this package, and
every case reports as skipped with the reason attached — which is the intended state in CI, since
a suite that drives a real deployment has no business running on a pull request.

```bash
pnpm install                                              # this package is new to the workspace
cp test/integration/.env.example test/integration/.env    # then fill in the URLs

pnpm --filter @scvs/e2e-tests run test                    # all non-infrastructure automated cases
pnpm --filter @scvs/e2e-tests run test -- cases/sub       # one group
pnpm --filter @scvs/e2e-tests run test:auto               # functional AUTO + browser cases
pnpm run test:perf:locust                                 # Locust PERF-01 closed-loop workload
pnpm run test:perf:locust:open                            # Locust PERF-02 fixed-interval workload
pnpm run test:smoke                                       # the public-system smoke subset
```

`test:smoke` is a named subset of the canonical E2E cases, not a second implementation. Its single
selection manifest is [`setup/smoke-cases.ts`](setup/smoke-cases.ts): verification health,
`E2E-SUB-01/testnet`, `E2E-SUB-03`, the two source-upload flows, query address/open-surface checks,
the verifier manifest, and the public Web console's preflight. These cover cli-legacy and cli-58
with both public `source_uri` and private `upload_id` references. The command selects case IDs with
Jest's test-name pattern, so a neighbouring case in the same spec file does not run. The cli-58
private upload's existing fixed provisioner creates its run-scoped fixture before running that one
case. The runner fails an enabled smoke run if a selected
direct Jest case was not executed. The public Web case runs first, before any build-producing Jest
case, so a broken console or ALB default route fails without consuming Batch capacity.

The manual `E2E integration` workflow accepts `test_suite`: `smoke` runs this subset, `e2e` runs
the regular automated E2E suite, and `perf` runs **only Locust `PERF-01`**. The path reads
`perf_users`, `perf_duration_seconds`, `perf_think_time_seconds`, `perf_max_rebuilds`, and
`perf_drain_timeout_ms` from the dispatch form. Users must not exceed the committed
`performance_verified` pool in `fixtures/e2e-fixtures.dev.json`; the global rebuild cap must be at
least the user count. CI uses that persistent testnet pool directly and neither builds nor deploys
fixtures in the perf path. GitHub serializes perf runs for an environment, but a local performance
run must not overlap one because both use the same contract addresses. PERF-02 is a local-only
workload. In CI,
smoke reuses the run-local `F-58-PRIV` fixture already prepared by
the workflow; on a local machine without that fixture, it runs the fixed provisioner and therefore
needs `SCVS_FIXTURE_TESTNET_ACCOUNT`.

Every suite writes its own machine-readable report — Jest `--json`, Playwright `--reporter=json` —
into `SCVS_E2E_REPORT_DIR` when that is set, named `<label>-jest.json` / `<label>-playwright.json`
after the step that produced it. In CI the workflow sets it to `artifacts/e2e-reports`, and
`eng-tools/write-e2e-summary.mjs` renders those reports into the run's job summary: a per-suite
pass/fail/skip table, each failure's message, the skips grouped by the prerequisite they name, and a
case-by-case table. It runs on `always()`, because a failed or half-skipped run is when that verdict
matters most, and it never fails the job — the suite step already reported the outcome. Set the same
variable locally and run the renderer with no arguments to print the same Markdown to stdout.

`test:auto` runs every functional `AUTO` E2E case whose fixture is already provisioned, plus
Playwright's `BROWSER` cases. `E2E-UPG-01/normal_upgrade_lifecycle` is the exception: its fresh
address and signer are deliberately supplied only by its explicitly selected provisioner, so CI
runs it as a separate targeted Jest step after `test:auto`. The two Docker-hosted Locust workloads are
`test:perf:locust` for PERF-01 closed-loop traffic and
`test:perf:locust:open` for PERF-02 fixed-interval bursts, which start at their configured interval
without waiting for earlier flows to settle.

Three gates, each opt-in separately, matching plan §1.2.1's execution modes:

| Variable | Unlocks | Why it is separate |
| --- | --- | --- |
| `SCVS_E2E=1` | everything | a real deployment is being written to |
| `SCVS_E2E_ALLOW_PERF=1` | `PERF` | performance and capacity probes consume shared build capacity; both Locust commands require it |
| `SCVS_E2E_ALLOW_BROWSER=1` | `BROWSER` | Playwright against the deployed public Web console |

`MANUAL` cases are not implemented in this package. `BROWSER` cases use Playwright and require
`SCVS_E2E_WEB_URL`; install Chromium with
`pnpm --filter @scvs/e2e-tests exec playwright install chromium` before running them locally.

## Why a skip always says why

Every gate prints its reason into the test name, so a run's own output is the checklist of what the
runner still has to supply:

```
E2E-SUB-01/mainnet — … [AUTO] · SKIPPED: fixture F-LEG-1-MAINNET is not in the inventory
E2E-SEC-03 · /entry_count_bomb · SKIPPED: 📐 LIMIT_TAR_ENTRIES: unavailable — SCVS_E2E_ENV is unset …
```

A CI run's job summary groups these by reason rather than counting them, which turns the same
checklist into one screen: `missing SCVS_E2E_ADMIN_TOKEN — 6 cases` says what to supply next in a way
that a green run with sixty silent skips does not.

This follows the reasoning already in `services/builder/test/isolated-stage-egress.spec.ts`: *"a
Docker-gated test is `describe.skip` on every machine without one, which is indistinguishable from
having no test at all while looking like coverage."*

The 📐 skips are the ones worth reading. Nine numeric parameters have no fixed spec value — tar
entry limits, quotas, the build wall-clock ceiling — and most of them belong in `policy.json`. A
case whose parameter is missing skips rather than inventing one, because a case that invents its
own threshold is asserting the harness's guess.

For `test_suite=e2e`, `e2e_scope=auto` is the routine suite, `slow` runs only the three real
builder-timeout cases, and `all` runs both. The latter has a 240-minute workflow limit; `slow` has
90 minutes and skips Playwright and the normal upgrade lifecycle.

For a local managed-environment run, set `SCVS_E2E_ENV=dev|staging`. The harness then reads archive
bounds from `config/deploy/<env>/builder.json` and retry policy from
`config/deploy/<env>/orchestrator-svc.json`. The reusable CI workflow cannot read those files because
it checks out the application repository, so its operations caller passes one
`scvs-e2e-deployment-evidence-v1` JSON object. It contains the three `SCVS_MAX_SOURCE_ARCHIVE_*`
limits, builder `SCVS_CLI_TIMEOUT_MS`, retry policy, and the route quotas. Automated E2E refuses to
start if its schema, fields, or positive-integer values are invalid; this prevents a deployment-contract
drift from looking like skipped coverage.

The three legacy `SCVS_E2E_LIMIT_*` archive-bound variables remain refused. A local harness variable
cannot stand in for evidence about a deployment; see [`.env.example`](.env.example) for the two
admissible evidence paths. Other optional parameters still skip when their deployment has no published
source.

## No case mutates deployment state

Every case here enters through the public surface and reads. No case stops a service, edits the
Trusted Verifiers List, injects a storage fault or shells out, and the harness has no generic
shell-command hook. Deployment mutation is an explicit Operations action with a restoration plan,
carried out and evidenced outside this package; the test process receives facts and read-only
public URLs.

## The drift ledger

A case can describe a target the implementation has not yet reached. A suite has to do something
honest with that. Failing on every divergence would produce a wall of red that says nothing new
each run; quietly asserting what the implementation does instead would report conformance the
system has not earned.

So known divergences are **recorded, not swallowed**. [`support/conformance.ts`](support/conformance.ts)
holds one entry per gap, each naming the document that already records it, and a run ends with:

```
── TRD conformance drift: 3 observation(s) across 2 gap(s) ──
   RC2/RC6-schema_version  (2)
     · E2E-SUB-08/policy_rejected: expected string, received undefined
   ...
```

`SCVS_E2E_STRICT_TRD=1` turns every entry back into a hard failure — that is the mode for checking
whether a gap has closed. If an assertion under `expectPerTrd` *passes*, nothing is recorded: the
gap has closed on this deployment and the next step is to delete its entry and let the assertion
become ordinary.

### Where a case, not the implementation, was out of date

Two assertions were written against a status-object shape this project withdrew — see
[rules 19–20 of `docs/invariants.md`](../../docs/invariants.md):
`E2E-DEDUP-05/different_input_is_new_job` HA2 asserted *two* mismatched records for one hash, and
`E2E-SRC-07` asserted the same. The status object holds **one entry per verifier per Wasm hash**, so
neither could pass on a conformant deployment.

These were **never** drift-ledger entries: the implementation is right and the cases were stale, so
recording them as implementation drift would have pointed the finger backwards. Both case files, and
a stale parenthetical in `E2E-DEDUP-04` HA2, were **corrected 2026-08-17**, and the multiplicity rule
now stands as a directory-wide convention so the next case cannot re-derive the withdrawn shape. The
specs here assert the corrected form: the single entry *moves* to the newer source, both report
artifacts still resolve, and every candidate archive stays retrievable by its own `source_sha256`
even after the index stops pointing at it.

Finding this was the suite doing its job before it ran a single case, which is worth noting: the
divergence was invisible while the cases were prose and became obvious the moment something had to
encode them as assertions.

The same shape, again, on 2026-09-10: the harness — not a case — was the stale side. `GET …/log`
became token-authenticated (build-log-access BL-1, landed 2026-09-08) and
[`support/job.ts`](support/job.ts) still asked for it bare, so thirteen assertions across six specs
read a `401 build_log_token_required` envelope where they expected a log. The implementation is
right and the ladder is the requirement, so this was never a drift-ledger entry either: the harness
now captures the one-time `build_log_token` out of each submission's 202 and sends it back in
`X-Build-Log-Token`. The capture sits in `http()` rather than the submit helpers, because the token
is issued exactly once and is never re-issued — see [`support/build-log-token.ts`](support/build-log-token.ts)
for why no call site may be allowed to bypass it.

**A gap entry must name a document that already records it.** A test failing for a reason nobody has
written down is a bug and belongs in a plain `expect`. Adding a gap to quiet an unexplained failure
turns a finding into furniture.

The known entries today:

| Gap | Substance |
| --- | --- |
| `RC2/RC6-schema_version` | `query-svc` emits `{error, message, status_code}` with no `schema_version`; `verification-svc` does stamp it. |
| `SO1-mismatch-vs-mismatched` | The published surface says `mismatched`, as SO1 requires. The *job* surface says `mismatch`. Two vocabularies, one word apart. |
| ~~`ROUTE-SOURCE`~~ | **Removed 2026-08-20.** `GET /v1/source/{sha}` still does not exist, but an unimplemented TRD route is a defect rather than a divergence, so `E2E-SRC-01` now asserts it and a deployment without it is red. |
| `SEC-03-reason` | None of the seven §4.5 reasons describes a reachable, hash-correct, malicious archive. |
| `GAP-4-no-job-no-log` | §4.5 promises a log for every failure; §7.6 says three synchronous rejections create no job to attach one to. |
| `GAP-3-no-cache-hit-signal` | Nothing published says whether a build was reused, so Rule A is asserted through the case files' three-condition substitute. |
| `SUB-13-bldopt-error-code` | A split `--manifest-path` is refused (S12 holds) but as `invalid_manifest`, not `policy_rejected`. |
| `PUB-07-build_log_url` | No `build_log_url` field exists anywhere in the codebase. |

## Routes: one file holds the drift

The case files use TRD §8.1/§8.2 target paths and say so: *"Current implementation paths differ, and
these cases do not accommodate them."* [`support/routes.ts`](support/routes.ts) is where they are
accommodated — cases call each route by its **TRD name**, and the single line resolving it to what
is actually served lives there, with the divergence documented next to it. When a route catches up,
one line changes and no case is touched.

The one that is not a rename: `GET /v1/source/{source_sha256}` has no implementation at all.

## `no second build`

The whole DEDUP group rests on the rule that a repeated build is never redone, which nothing
published can express directly — there is no rebuild ID and no cache-hit indicator. A
three-condition substitute stands in for it, and [`support/dedup.ts`](support/dedup.ts) implements
exactly that: the second run finishes in under a
fifth of the first's wall clock, both reports carry the same rebuilt hash and size, and both build
logs are byte-identical.

Condition 3 carries a caveat the case file states and does not resolve. **If this deployment
regenerates the build log on reuse, byte-identical logs can never hold**, and the DEDUP group is
characterization-only until the gap closes. `evaluateNoSecondBuild` reports each condition
separately for that reason — "the logs differ" and "the logs were not comparable" are different
findings, and collapsing them into one boolean would hide which of the two happened. Check this on
the first run.

## Fixtures

Fixtures are deployment state, not code. `F-LEG-1` is a specific contract on a specific network
with a specific archive at a specific URL, and [`test/fixtures/e2e/`](../fixtures/e2e/) already owns
the scripts that build and deploy them — `build-purpose-contracts.sh`, `deploy-testnet.sh`,
`generate-fixtures.sh` — with `registry.yaml` recording which are currently `ready`.

`fixtures/e2e-fixtures.dev.json` is the base inventory for stable dev fixtures. Dev CI overlays its
fresh core deployment records into `artifacts/e2e-fixtures/e2e-fixtures.ci.json` and points
`SCVS_E2E_FIXTURES` there. Anything left out makes the cases needing it skip, naming the ID;
contract ids must never be inferred across networks. A relative `SCVS_E2E_FIXTURES` path is always
resolved from the repository root, not the `test/integration` package directory.

Local runs may reuse stable fixtures. `F-LEG-1`, `F-LEG-3`, and the second mismatch candidate opt
into a recipe scope derived from the harness run id, Jest case name, and fixture id. This prevents
retained Rule B/C results from satisfying a later run while keeping repeated submissions inside one
case identical for deduplication. Set `SCVS_E2E_RUN_ID` only when reproducing a specific run;
otherwise the harness generates one at startup. Dev CI adds the stronger per-run deployment below.

Timeout cases use three run-scoped targets, `F-SUB09-TIMEOUT`, `F-SUB10-TIMEOUT`, and
`F-RULE-D-TIMEOUT`, rather than stable addresses. The fixture provisioner deploys F-LEG-1's Wasm
under three salts derived from the current run ID, writes a temporary inventory, and then runs the
explicitly selected timeout case. This is
load-bearing: Rule D leaves retries active after the assertion, so a stable timeout target would block
the next run through target-level active-job dedup.

Select a timeout case explicitly to provision its run-scoped targets locally:

```bash
pnpm --filter @scvs/e2e-tests run test -- \
  cases/sub/sub-10-build-logs.spec.ts \
  -t 'E2E-SUB-10/build_timeout'
```

The local provisioner requires a funded `SCVS_FIXTURE_TESTNET_ACCOUNT` alias and the existing
`f-leg-1-official.wasm` plus `build-timeout.tar.gz` fixture artifacts. It writes only ignored
run-local deployment evidence and inventory beneath `artifacts/e2e-fixtures/timeout/`.

`F-PRIV` targets the same deployed bytes and uses the same recipe as `F-LEG-1`, but its archive adds
a non-build canary file and therefore has a distinct `source_sha256`. The fixture preparation step
recreates that archive deterministically. This lets SRC-05 prove the private object is absent without
accidentally finding SRC-01's public copy, and removes the old host-only
`SCVS_E2E_PRIVATE_UPLOAD_PATH` prerequisite.

`F-LEG-3` requires a dedicated target, separate from `F-LEG-1`, and the dev CI target must also have
a fresh Wasm hash on every run. The workflow builds both core targets, injects a run-specific inert
constant into F-LEG-3, deploys them with a run-scoped salt, generates a temporary inventory, and
validates it against the deployment evidence before Jest starts.

`E2E-SRC-05/cli_58_private_upload` uses the same isolation principle for cli-58, but it cannot add a
submitter recipe nonce because its recipe is immutable chain metadata. Selecting the case with the
ordinary E2E test command provisions a fresh source canary, archive, Wasm, testnet deployment, and
inventory before Jest runs it:

```bash
pnpm --filter @scvs/e2e-tests run test -- \
  cases/src/src-visibility.spec.ts \
  -t "uses upload_id instead of the chain's source_uri"
```

It requires Docker, Rust/Cargo, the target deployment URLs, and
`SCVS_FIXTURE_TESTNET_ACCOUNT` set to a funded local Stellar key alias. The automatic provisioner is
activated only for this explicit case selection; root `pnpm test` and other E2E selections retain the
safe no-deployment behavior. The provisioner uses the released Stellar CLI helper for metadata
inspection; it does not build or cache the retired PR-pinned `verify` binary.

The ZIP source-tree rows provision their own two disposable cli-58 fixtures automatically, rather than
requiring a pre-generated inventory. They build and deploy only `F-58-ZIP` and `F-58-ZIP-PUBLIC`, then
write a run-local overlay before Jest starts:

```bash
pnpm --filter @scvs/e2e-tests run test -- \
  cases/src/src-visibility.spec.ts \
  -t 'E2E-SRC-(05/cli_58_source_tree_zip_upload|02/cli_58_source_tree_zip_public_upload)'
```

`E2E-UPG-01/normal_upgrade_lifecycle` provisions the same way, but its spec file holds exactly one
case, so naming the file is the selection and no `-t` is needed:

```bash
pnpm --filter @scvs/e2e-tests run test -- \
  cases/upg/upg-normal-lifecycle.spec.ts
```

The runner creates an isolated address, verifies its v1 source, upgrades only that address to v2,
verifies its v2 source, and checks that address queries immediately resolve to v2. It requires the
same local key alias and target URLs. The full `test:auto` command deliberately does not provision
either dynamic fixture without an explicit selection.

Configure the funded testnet signing key as `SCVS_FIXTURE_TESTNET_SECRET_KEY` in the protected GitHub
`dev` Environment. CI exposes it only to named run-scoped fixture provisioners and the targeted
upgrade lifecycle Jest step; the regular `test:auto` process never receives it. CI does not commit,
push, or otherwise write deployment values back to `registry.yaml` or `e2e-fixtures.dev.json`; the
generated inventory and public deployment evidence are uploaded as run artifacts. The `E2E integration` workflow is
manual-only and runs against `dev` when started with the required `environment` input, whose only
current option is `dev`.

`F-ADV-PLANT` and `F-ADV-BUILDRS` (`E2E-SEC-01`/`-02`) are **wired in as of 2026-08-19**. They are not
generated by this package and never will be: their preparation order is load-bearing — plant the bytes
*before* computing `source_sha256`, keep the planted and the real `.wasm` names distinct so cargo cannot
overwrite the plant — and `generate-fixtures.sh` already does it properly, so approximating them here
would produce a fixture that passes for the wrong reason. What changed is that the inventory now points
at the archives that script writes.

Three details about them are worth knowing before editing either case:

- **They target F-LEG-1's contract**, because planting *that* contract's bytes is the attack. So
  `generate-e2e-ci-inventory.mjs` rewrites their `contract_id`/`wasm_hash` from F-LEG-1's deployment
  record alongside F-PRIV's; a stale target would mean planting bytes nobody is verifying, and the case
  would pass because the attack missed.
- **Neither reads the status object.** F-LEG-1's case verifies that hash and rule 20 (`docs/invariants.md`)
  keeps a `verified` entry ahead of any later `mismatched`, so the published record correctly keeps
  saying `verified`. The
  verdict for these submissions is on the job surface and in their own report artifact.
- **`SEC-02` fails when the plant did not happen.** A `build.rs` that silently failed to write would make
  the case pass while testing nothing, so a log with no `[F-ADV-BUILDRS] plant result=Ok` is a fixture
  failure with that said in the message, not a green run.

`F-BULK` (200 distinct submissions) is still deliberately not generated here — it is `PERF`/`SEC-08`
territory and belongs in a load harness.

### `F-S55-A/B/C/D/E/F` — SEP-55 marker fixtures

The SEP-55 group tests **format detection, not verification**, so its
cli-legacy variants are built from the same `verified-demo` source in the same digest-pinned official
image and differ only in `--meta source_repo`. They share F-LEG-1's `source_sha256`, while their Wasm
hashes differ with their metadata. F-S55-D is the separate cli-58 coexistence fixture.

| Fixture | On-chain `source_repo` | Class | Marker |
| :---- | :---- | :---- | :---- |
| `F-S55-A` | `github:example/contract` | cli-legacy | `true` |
| `F-S55-B` | `https://example.com/src.tar.gz` | cli-legacy | `false` — legacy SEP-58 v0.4.0 vocabulary |
| `F-S55-C` | `https://mirror.example.com/github:foo` | cli-legacy | `false` — contains `github:`, does not begin with it |
| `F-S55-D` | `github:example/contract` | cli-58 | `true` — plus a complete SEP-58 recipe (the coexistence case) |
| `F-S55-E` | `GitHub:example/contract` | cli-legacy, run-scoped | `false` — RA5's lowercase literal does not match |
| `F-S55-F` | `github:` | cli-legacy, run-scoped | `true` — RA5 observes the prefix and does not parse an owner/repository |

Three things about them that are easy to get wrong:

- **The `--meta=…` entry in the submitted `bldopt` is inert.** When a target records
  `metadata_replay`, `run-cli.ts`'s `removeRecordedMetaBldopts` strips every recorded `--meta` option
  from the forwarded set and replays the chain's own entries instead. So the option is carried in the
  inventory because it is what produced the deployed bytes, not because the rebuild needs it.
- **A/B/C/E/F are `run_scoped_recipe`, D cannot be.** `E2E-SEP55-04` submits D **target-only** so
  verification-svc infers the manifest from chain metadata — that submission shape is what the case is
  about — which leaves nothing to scope. §7.6 Rules B/C may therefore adopt an earlier publication for
  it, and an adopted artifact predating RA5 carries the old hardcoded `trust.sep55_attestation_present:
  false`. If that assertion fails, republish the stored result before suspecting the observation.
- **D has no rebuild validation line in `registry.yaml`.** Its on-chain `bldopt` records
  `--meta=source_repo='github:example/contract'` with the shell quotes `build-purpose-contracts.sh`
  wrote, and nobody has recorded a byte-equal rebuild against it. The SEP-55 cases accept either
  published verdict for exactly this reason: the marker is computed from chain metadata in both, and
  requiring `verified` would couple the two things §7.5 exists to keep apart.

### `F-FLOOR-REFUSE` — the one fixture that cannot be built

`E2E-SUB-09/unsupported_toolchain` needs a contract that classification routes to **compose** and the
composer must then refuse **permanently**. Two families qualify, both decidable from chain metadata alone,
and the case derives which one to expect from what the chain records:

| Reason | Trigger | Observed live |
| :---- | :---- | :---- |
| `unaddressable_cliver` | the recorded `cliver` is not a shape `parseCliver` understands | `25.2.0#` — trailing separator, empty rev |
| `toolchain_target_unavailable` | the recorded `rsver` ships no `wasm32v1-none` (nothing below 1.84.0 does) | `1.81.0`, the corpus's class-B floor |

**Found and registered 2026-08-19**: `CDZZY4MN4KV73AF43PQ7UF2LASI6COPWMLLT5YVM5RS2LVIJABU32JZR`, cliver
`25.2.0#`, Wasm `06186e93…`, `registry.yaml` status `ready`. Found in a 20-contract sample.

★ Its inventory entry carries **F-LEG-1's** `source_uri`/`source_sha256`, and that archive does **not**
reproduce these bytes — it is not supposed to. The verdict is reached before the archive is opened, so the
source and the `bldarg`/`bldopt` beside it are inert; they are present only so the submitted manifest is a
complete one. This is the one fixture in the inventory whose source is deliberately unrelated to its
target, and the note on the entry says so, because the next reader's first instinct will be that it is a
copy-paste mistake.

Every other cli-legacy fixture here is built by `build-purpose-contracts.sh`. This one cannot be, for
either family, because **the CLI writes both fields**: `stellar contract build` chooses the wasm target
itself (measured on the corpus's oldest CLI, 23.2.0), so no image we can assemble emits a contract on a
toolchain lacking it; and a real binary does not stamp `25.2.0#` with an empty rev. Faking either with an
extra `--meta` entry would be worse than not testing — it fabricates chain state, and both
`assert_metadata_value` and the discovery script treat a repeated key as unreadable rather than pick a
winner.

**★ It is still reachable, and the reason is worth reading because it looks like `F-PUBTEST`'s wall.**
`F-PUBTEST` is blocked on rebuild evidence. This case's expected verdict is a refusal reached *before any
source is fetched, compiled or compared*, and nothing is published — so no source has to reproduce the
deployed bytes and no cooperation from the deployer is needed. F-LEG-1's `source_uri`/`source_sha256` are
fine for it; the archive is never opened.

```bash
node test/fixtures/e2e/find-refusable-contracts.mjs --check CDZZY4MN…U32JZR   # prints the finished entry
node test/fixtures/e2e/find-refusable-contracts.mjs --scan                    # look for more
```

It reads each contract's own deployed Wasm off the network, parses the metadata with the same
`stellar contract info meta` every other fixture uses, and judges it with `@scvs/core`'s own `parseCliver`
and `classifyBuildEnvironment` — imported from built output, not copied.

**★ Two things the first `--scan` run taught, both now structural.** Its own copy of the cliver shape
rules tested `cliver.includes("#")` for a missing rev, which an empty rev satisfies — so it walked past
`25.2.0#` reporting "rsver 1.94.0 is servable", true and beside the point. That is why it now imports the
real functions instead. And `--scan` is weaker than "pagination is broken": all 20 ids it returned began
`CDZZ`, because `order=desc` is a lexicographic walk from the top of the id space, not a sample. Paging
further descends the alphabet; it does not widen toolchain coverage. The corpus scan already enumerated
all 99 live pairs — ids from its dataset, fed to `--check`, is the strategy that terminates.

### `F-COMPOSE-ONLY`, `F-DEMAND-01`, `F-OLD-END` — pairs with no official image

`E2E-SUB-02/compose_unofficial_pair` needs contracts on `(cliver, rsver)` pairs Docker Hub publishes no
image for, which no fixture had. The 2026-07-30 corpus scan is why it matters: six official pairs against
99 live ones, so **92.6% of live class-B contracts can only ever be verified through composition** — and
until these existed, every E2E composition ran on a pair somebody had already shipped as a single image.

They cannot come off the shelf. A real contract on such a pair is easy to find and impossible to *rebuild*
without the source, which is the wall `F-PUBTEST` is behind. So they are purpose-built, and the only
environment that can build one is one we compose.

All three deployed 2026-08-19, all `ready`:

| Fixture | Pair | `--locked`? | Why | Deployed |
| :---- | :---- | :---- | :---- | :---- |
| `F-COMPOSE-ONLY` | 25.2.0 / 1.94.0 | yes | Rank 2 (10.1%). First of its kind — chosen because a specific public contract raised the question, not on demand. | `CB6BPRLO…` / `b052d489…` |
| `F-DEMAND-01` | 25.1.0 / 1.95.0 | **no** | **Rank 1**: 813 live contracts, 25.2% of live class-B, more than ranks 2 and 3 together. | `CACXUT2P…` / `67bafc0b…` |
| `F-OLD-END` | 23.3.0 / 1.91.1 | **no** | The old end — rank 4, oldest CLI major with real demand, only fixture below rust 1.94. The corpus's risk lives here. | `CCT6PKZ4…` / `ea0c44b0…` |

**★ `--locked` is a property of the cliver, not of the family.** `stellar contract build` gained it between
25.1.0 and 25.2.0, so the 25.1.0 and 23.3.0 rows must not carry it — a recipe with an option its own cliver
cannot accept describes a build that could not have happened, and no real contract on those pairs records
it either. The build options therefore live in `compose_targets` per row, alongside the pair, and
`build-purpose-contracts.sh` reads the image's `contract build --help` before spending anything so the
whole unsupported set is named at once instead of one option per 20-minute run.

What that gives up is that `--locked` turns "cargo silently updated `Cargo.lock`" into an error. The
F-OLD-END build is the evidence it costs nothing here: built *without* `--locked`, it still resolved
`rssdkver 25.3.1#e50d95af` — the same SDK every `--locked` build got. One observation, not a proof, but it
is the observation the claim was missing.

`check-composition-matrix.mjs` composed all three pairs, so the *environments* exist. What these fixtures
add is whether a **submission** on them reaches a verdict, which is decided three files away.

All four Wasm hashes — these three plus F-LEG-1's — are distinct, and all four are 626 bytes with the same
`rssdkver`. Same source, same SDK, four toolchains: the pair is the only variable across the set.

```bash
# 1. compose the image for THIS pair (leaves scvs-composed:template-gate-v3 behind)
node eng-tools/check-composition-template.mjs \
  --cliver '25.1.0#a048a57a75762458b487052e0021ea704a926bee' --rsver 1.95.0 \
  --keep-image --no-contract-build

# 2. build the contract inside it — one target per run
SCVS_FIXTURE_BUILD_SCOPE=compose-only SCVS_FIXTURE_COMPOSE_TARGET=F-DEMAND-01 \
  SCVS_FIXTURE_BUILD_IMAGE=scvs-composed:template-gate-v3 \
  bash test/fixtures/e2e/build-purpose-contracts.sh

# 3. deploy whatever has been built; it names what is still missing
SCVS_FIXTURE_TESTNET_ACCOUNT=<alias> SCVS_FIXTURE_DEPLOY_SET=compose-only \
  bash test/fixtures/e2e/deploy-testnet.sh
```

Then promote in `registry.yaml` and add the inventory entry — until that happens each case skips and says
which of the two is missing (`missingDeployedTarget` distinguishes "not written down" from "written down
but not deployed", because an entry with no `contract_id` would otherwise fail on a 400).

**★ One image tag, three pairs.** The composition gate always tags `scvs-composed:template-gate-v3`, so
step 1 must be re-run *between* targets. Skip it and the next fixture is built in the previous one's
toolchain — a deployed contract that lies about its own pair, and every later assertion still passes.
Four independent guards exist because of it:

1. `build-purpose-contracts.sh` reads `cliver`/`rsver` back out of the built Wasm and requires the row's
   pair. The image does not get to be trusted about itself, and this is the load-bearing one.
2. It also refuses bytes identical to `f-leg-1-official.wasm` **or to any sibling** in the table.
3. `generate-e2e-ci-inventory.mjs` refuses a deployment set where two compose fixtures share a Wasm hash
   — the case where the two builds happened on different machines and guard 2 never saw both files.
4. Each case re-checks its pair against the six official ones, once from preflight and once from the
   published recipe.

`eng-tools/check-fixture-tables.mjs` keeps the three places these fixtures are written down — the build
table, the deploy list and `registry.yaml` — from drifting apart. No network, no Docker, runs in a second.

**What they do not prove.** Our composer builds them and our composer verifies them, so a byte match is
the pipeline working and the composition being reproducible — not our composed 25.1.0/1.95.0 agreeing
with somebody else's, because there is no official one to agree with.
`E2E-SUB-02/compose_cache_miss` carries that half: F-LEG-1's bytes came out of the *official* image and
composition reproduces them.

`F-ADV-TAR` *is* generated, in [`support/archives.ts`](support/archives.ts), by writing ustar
headers directly — for the reason `services/builder/test/malicious-corpus.ts` gives: GNU tar strips
a leading `../` at create time while bsdtar keeps it, so a tar-built traversal fixture tests the
local tar rather than our validator.

## Coverage

Implemented, by case ID. Every case here runs against the normal dev/staging topology through the
public surface. A case needing a maintenance window, a fault injector, a mainnet deployment or an
Operations export is not implemented here; the omissions column says which, and the behaviour stays
covered by component tests.

| Group | Implemented | Notable omissions |
| --- | --- | --- |
| SUB | 01 (×2 networks), **02/compose_cache_miss**, **02/compose_cache_hit**, **02/compose_unofficial_pair (×3 pairs)**, **03**, 04, 05 (×3), 06, 07/mismatch_no_retry, 08 (×3), **09/unsupported_toolchain**, 10, 13 (×2), 14 (×2), **18/dry_run** | 09's infrastructure suffix; 11, 12 (need a deployment-mutating window); 15 (BROWSER); 16 (needs the CLI helper) |
| DEDUP | 01, 02 (×4), 03, 04/verified_is_terminal, **04/force_reverify_not_user_facing (public negative half)**, 05 (×2), **06/build_timeout_requeued**, **06/non_retryable_returned_for_correction** | 03/cross_network (needs the same bytes deployed on mainnet); 04 operator force-reverify + audit evidence (blocked on undefined/unimplemented P11); 06/internal_error_requeued (needs an injected infrastructure fault) |
| PUB | 02, 04 (×5), 07, 08, 09, 11 (×3), 14, 15, 17 (×2) | 06 (needs a source somebody can switch off); 10 (needs the same bytes deployed on mainnet); 01, 05, 12, 13, 16 (need a deployment-mutating window); 03 (needs the draft Registry schema) |
| QRY | 01, 06, 07, **08**, 11, 12, **13** | 02–05, 09, 10 are component-only because normal dev/staging cannot create policy disagreement, controlled peer failure, or three TVL states |
| VERIFY | **HEALTH** | — |
| WEB | **01/public_console_preflight**; SDK-04/browser | Result explorer remains feature-flagged |
| SDK | **01, 02, 04/node + browser, 07** | 03 has no public E2E; 06 is **RELEASE** and lives outside this harness (`eng-tools/check-sdk-registry-install.mjs`, run by `release.yml` after the publish step) — it needs a published version, not a deployment. Peer failure and `results_urls` safety are SDK component tests |
| SRC | 01, 04, 05, **06**, 07 (rewritten per docs/invariants.md rule 20) | 02 (subsumed by 04's upload path); 03 (needs a privileged staging observer); 08 (needs a source somebody can switch off); 11 (needs an object-store fault injector); 10 (MANUAL) |
| SEP55 | **01, 03/legacy_source_repo, 03/contains_but_not_prefix, 03/case_variant, 03/empty_after_prefix, 04** | 02 (needs P8 per-domain egress blocking); 05, 06 (MANUAL) |
| SEC | **01, 02**, 03 (×4), 04, 05/manifest_path_escape, 11, 12, 14/no_management_surface, 14/policy_matches_boot | 06, **07 (component-only in builder; no E2E without deployment-level network telemetry)**, 08–10, 15, 16 (need a P8 Operations export or a deployment-mutating window); 13 |

## Conventions

- Specs live in `cases/`. `support/` is the harness and is excluded from `testMatch`.
- A `describe` is named with its case ID, so a Jest report reads as a QA run and a failure names
  something searchable by ID.
- Relative imports carry `.js` extensions — the repo is ESM and `moduleNameMapper` rewrites them
  back to `.ts`, same as every service's Jest config.
- `--runInBand`, always. One deployment, one caller: parallel workers would race the submission
  quota (S15) and the shared build queue against each other.
- No `jest.setTimeout`. Long cases pass their timeout to `it(...)` explicitly, following
  `services/builder/test/differential/differential.spec.ts`.

## What this suite creates, and does not clean up

Every row it creates is created *by the deployment*, through the public API — there is no direct
database access, so rule 21's ownership rule (`docs/invariants.md`) is satisfied structurally rather than by bookkeeping.

But it does leave things behind: published results are immutable by design (`E2E-PUB-05`), and a
`verified` verdict is terminal for the recipe that produced it (§7.6 Rule B). The run/case recipe
scope makes the core verified/mismatched cases repeatable against this retained state; the stable
hash documents will accumulate legitimate updated entries rather than being deleted between runs.
