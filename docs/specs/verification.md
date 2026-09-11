# Verification

As built. See `Verified by:` on each claim.

## Contract classes

Every deployed contract falls into exactly one class, fixed permanently by how it was originally
built — a deployed Wasm never acquires metadata later.

| Class | On chain | Recipe source | Environment |
| :---- | :---- | :---- | :---- |
| **cli-58** | complete SEP-58 recipe (`bldimg`) | the deployed Wasm | the chain-named digest, policy-checked |
| **cli-legacy** | `cliver` + `rsver`, no `bldimg` | submitted source, tested against the recorded pair | composed from the pair (see [`build-environments.md`](build-environments.md)) |
| **cli-none** | no CLI record | — | `unsupported` |

The "Environment" column is which build image the class resolves to; which mechanism performs the
rebuild is a separate question, covered below.

Verified by: `services/orchestrator-svc/src/modules/verification-pipeline/chain-reader.service.ts`,
`packages/core/src/wasm-metadata.ts`

## Mechanism

**One mechanism performs every rebuild, for cli-58 and cli-legacy alike: the verifier's own
two-stage sandbox.** `selectBuildMechanism` is pure, total, and returns `mode: "build"` for every
input — its branches exist only to compute `reason`, persisted as `recipe_source`. A cli-58 target's
build image is the chain-named, policy-checked digest; the sandbox builds against that digest.

Verified by: `services/orchestrator-svc/src/modules/verification-pipeline/mechanism-routing.util.ts`

A sandbox execution failure is terminal — there is no other mechanism to demote to. A stale
`cli_failure` is re-opened for the next job that attaches (a fresh attempt, not a demotion), never
retried in place.

Verified by: `services/orchestrator-svc/src/modules/verification-pipeline/failure-reason.util.ts`

**cli-none returns `unsupported`.** This is a policy choice, not a capability limit.

## The two-stage sandbox

Builds need dependencies; dependencies need network; a build with network access is neither
reproducible nor isolated. Stage 1 (network allowed, egress allowlisted) prefetches dependencies and
toolchain components; Stage 2 (`--network none`) runs the build and replays recorded arguments.

Verified by: `services/builder/test/isolated-stage-egress.spec.ts` (`--network none`, end to end
through the assembled command), `services/builder/test/egress-policy.spec.ts` (Stage 1 allowlist)

Archives are validated before extraction (path traversal, symlinks, entry count, size); source bytes
are checked against `source_sha256` before the build starts.

Verified by: `services/builder/test/archive-extraction.spec.ts`,
`services/builder/test/materialise-canonical-archive.spec.ts`

Build output is captured, redacted for credentials and local paths, and retained for every terminal
outcome, `build_failed` included.

Verified by: `services/builder/test/build-log.spec.ts`, `services/builder/src/modules/builder/redact.ts`

The sandbox holds no database connection, no object-storage credentials, no publishing keys — see
[rule 1 of `docs/invariants.md`](../invariants.md).

## Byte equivalence

**Replay, do not recompose.** The rebuild reproduces the deployed Wasm's metadata section by reading
the recorded entries out of the CLI-injected `contractmetav0` section and passing them back
verbatim — not by deriving them from the reference implementation's composition rules. A Wasm may
carry several `contractmetav0` sections; only the one containing `cliver` is replayed, and `cliver`/
`rsver`/`rssdkver` are dropped from it (they are regenerated, not passed in).

Verified by: `packages/core/src/wasm-metadata.ts` (`planMetadataReplay`,
`REGENERATED_META_KEYS`), `packages/core/src/wasm-metadata-test.ts`

**Replay, do not augment.** The rebuild passes what the recipe records and nothing else — no
argument the verifier adds on its own initiative, however reasonable, may reach the compiler.

Verified by: `services/builder/test/argument-policy.spec.ts`,
`services/builder/test/rejected-build-option.spec.ts`

**Differential testing against the reference implementation is a delivery requirement.** The same
source, image digest, and options must produce byte-identical output under both the reference CLI
and this verifier's rebuild. The reference is pinned to a specific upstream release and is never a
runtime dependency of the independent (cli-legacy) path.

Verified by: `services/builder/test/differential/reproducibility.spec.ts`,
`services/builder/test/reference-alignment.spec.ts`,
`services/builder/test/differential/differential.spec.ts`

## Artifact provenance

**The attack this defends against:** a submitter plants a pre-built `.wasm` — a copy of the deployed
contract's own bytes — via the source archive or a `build.rs` side effect, so a verifier that finds
"the rebuilt artifact" by scanning a directory publishes a false `verified`.

The artifact is the sole `.wasm` file in a dedicated output mount carrying nothing else, and the
build tool's own report must *confirm* the candidate rather than *select* it from an unconstrained
directory scan — a build tool's report text shares the same output stream a proc macro can write to,
so the report cannot be trusted to name the artifact on its own. Every `.wasm` already present in
materialized source is snapshotted before the build and excluded.

Verified by: `services/builder/src/modules/builder/artifact-selection.ts`
(`selectArtifactFromOutput`), `services/builder/test/planted-artifact.spec.ts`,
`test/integration/cases/sec/sec-planted-artifact.spec.ts`

## The trust boundary

See [rules 1–2 of `docs/invariants.md`](../invariants.md) for the load-bearing constraints (no sandbox
credentials, verdict computed trusted-side over self-hashed bytes). Each job runs in a fresh
sandbox — no filesystem, cache, or network state is shared between submissions.

Verified by: `services/builder/test/sandbox-freshness.spec.ts`,
`services/builder/test/trust-boundary.spec.ts`

**Container-execution capability.** `builder` must start containers and so holds a container
runtime's control endpoint — the highest-privilege element in the system, and distinct from the
inner container's own isolation. The holding component never parses or executes attacker-controlled
input directly (source retrieval and archive extraction happen in a separate step); the inner
container never receives the capability; and the build fleet's IAM role holds zero business
permissions (image pull and logs only) — see [rule 1](../invariants.md).

Verified by: `services/builder/src/modules/builder/sandbox-runtime.ts`,
`services/builder/test/sandbox-runtime.spec.ts`

## Failure taxonomy

A **valid verification** is a completed byte-for-byte comparison, yielding `verified` or
`mismatched` — stated in terms of outcome, not which mechanism ran the build.

**`mismatched` is a successful verification, not an error.** The comparison ran and the hashes
differ. This is expected for retroactive (cli-legacy) submissions and carries no accusation about
the developer's honesty.

A job that produces no verdict is never published (no negative claim is made for a contract "not yet
verified"); the submitter always gets the build log back.

| Reason | Meaning | Retryable |
| :---- | :---- | :---- |
| `policy_rejected` | Tag-only image reference, or a malformed/disallowed build option | No |
| `unsupported` | Well-formed and digest-pinned, but names a build class not yet supported | No |
| `missing_fields` | Required SEP-58 fields absent from both metadata and submission | No |
| `source_unreachable` | Source could not be fetched, or bytes do not match `source_sha256` | No |
| `build_failed` | The build ran and produced no Wasm | No |
| `build_timeout` | Wall-clock limit exceeded | Yes |
| `internal_error` | Infrastructure fault | Yes |

Verified by: `services/orchestrator-svc/src/modules/verification-pipeline/failure-reason.util.ts`,
`services/builder/test/recipe-failure-reason.spec.ts`

Only digest-pinned images are accepted; a mutable tag cannot support a reproducible verdict. The
image-acceptance policy is compile-time code, never operator-supplied runtime data.

Verified by: `services/orchestrator-svc/src/modules/verification-pipeline/policy.ts`
