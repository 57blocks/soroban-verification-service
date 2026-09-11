# Invariants

Rules that must remain true after the code implementing them is rewritten. This document replaces
the 21 ADRs that used to live in `docs/adr/` — an ADR's design reasoning, alternatives considered,
and migration history stop being true the moment the code they describe is rewritten; these rules
do not.

Format: rule, code location (where it is enforced or would break), reason (only the three rules
below whose violation is expensive enough to warrant one).

| # | Rule | Code location | Reason |
| - | --- | --- | --- |
| 1 | The builder holds no database access, no AWS SDK dependency, and no AWS credentials of any kind. It cannot read the result store, write results, or forge a verdict — a sandbox escape yields ECR pull + log write only. | `services/builder/package.json` (no `@scvs/db`, no `@scvs/aws`), `services/builder/test/trust-boundary.spec.ts`, `services/builder/src/modules/builder/upload.ts` | **Yes** — see below |
| 2 | The trusted side (orchestrator), never the sandbox, computes the verdict: it fetches the uploaded bytes and hashes them itself, and on disagreement with the sandbox-reported hash, the freshly-computed bytes win. | `services/orchestrator-svc/src/modules/verification-pipeline/` (`hashUploadedArtifact`) | — |
| 3 | `orchestrator-svc` always dispatches to AWS Batch. No in-process/local fallback build path may exist. | `services/orchestrator-svc/src/modules/verification-pipeline/batch-dispatch.service.ts` | — |
| 4 | Every DTO is a single `class-validator` class; it is the validation rule, the TypeScript type, and the source the OpenAPI schema is derived from. A schema is never hand-declared separately from the validation. | `packages/core/src/validate.ts` | — |
| 5 | `class-validator` must resolve to exactly one physical copy across the workspace — its metadata store is a module-level singleton, and two copies silently stop enforcing validation while tests stay green. | `packages/core/src/validate.ts` | — |
| 6 | A package published outside the workspace (e.g. the SDK) must not declare `sideEffects: false` if its bundle carries `reflect-metadata`'s import — that flag licenses a bundler to drop the polyfill the emitted metadata calls need. | `clients/sdk/package.json` | — |
| 7 | `BatchJobParams`/`BuildArtifact` live in `packages/core`, never in an AWS-aware package — routing them through an AWS package would drag the AWS SDK into the sandbox image. | `packages/core/src/` | — |
| 8 | AWS infrastructure is defined in Terraform outside this repository; this repository never creates AWS resources itself, only images, application configuration, and the deployment-configuration documents rule 23 below carries. | `config/deploy/README.md` | — |
| 9 | No environment variable that identifies infrastructure (account id, region, revision) is ever committed as a literal value in this repository. | `config/env-manifest.yaml`, `eng-tools/check-env-manifest.mjs` | — |
| 10 | `config/env-manifest.yaml` is the single declaration of the environment contract; the manifest, the code reading each variable, and each service's env DTO must agree, and CI fails when they don't. | `eng-tools/check-env-manifest.mjs` | — |
| 11 | A variable the builder must never read (`required: forbidden`) is a checked assertion: CI fails if the builder's source reads one or the builder Dockerfile sets one. | `eng-tools/check-env-manifest.mjs`, `eng-tools/check-builder-isolation.mjs` | — |
| 12 | The published by-hash result index and its query surface are keyed by Wasm hash alone and carry no network/chain field — a hash is a pure function of bytes with no chain reference. | `packages/storage-layout/src/keys.ts`, `packages/storage-layout/src/shapes.ts` | — |
| 13 | A `ResultPointer` in the by-hash index never carries `contract_id` — chain-scoped identity does not belong on a hash-keyed, chain-independent record. | `packages/storage-layout/src/publish.ts` | — |
| 14 | Every record document in the published result root is keyed by a hash (Wasm hash, report sha256, or source sha256) — never by contract address or by position in an ordering — except the two fixed-name singleton identity documents (`verifier-manifest.json`, `policy.json`). A new file in the root must pass the staleness test: a stale copy that would be *wrong* (not just incomplete) may not be a static file — it must be a served route or regenerated on every publish. | `packages/storage-layout/src/keys.ts`, `packages/storage-layout/src/shapes.ts` | — |
| 15 | A rebuild attempt (recompiling source+image+options) and a job's verdict (does the rebuild match what's deployed at a target) are separate entities. A job never borrows another job's verdict — every job independently re-fetches its target's current deployed hash and compares fresh, never from a cached/borrowed value. | `packages/db/prisma/schema.prisma` (`Rebuild`, `Job` models) | — |
| 16 | Rebuild environments for toolchain versions the ecosystem does not officially publish are composed only from on-chain metadata and official immutable sources (verified Rust toolchain releases, verified stellar-cli release binaries) — no submitter-supplied field ever participates in composing a trusted build environment. | `services/orchestrator-svc/` (build-environments module), `docker/` composer template | **Yes** — see below |
| 17 | No shared, multi-verifier build-environment registry: each verifier composes and caches its own environments from the same public template; trust follows verifier identity, not a shared registry others could poison. | `services/orchestrator-svc/` (build-environments module) | — |
| 18 | Every published verification result carries its build environment's full component recipe and checksums, so any third party can rebuild an equivalent environment and re-derive the verdict without trusting this verifier's cache. | `packages/core/contract/` | — |
| 19 | The status object holds strictly one entry per `(verifier, wasm_hash)` and carries no vendor-extension field — it must validate as strictly conformant to the published base schema. | `packages/core/src/registry.ts` | — |
| 20 | Latest `verified` wins for a given `(verifier, wasm_hash)` — except a `mismatched` outcome never displaces an existing `verified` entry for the same hash; only a new `verified` (from any source) may replace a `verified`. | `packages/storage-layout/src/registry-status.ts` (`buildWasmStatus`) | — |
| 21 | A test suite deletes only the database rows it created (tracked by id), and never sweeps a table it does not own. The shared Postgres is never reset between suites. | `packages/db` (`testing` helpers, `CreatedRows`) | — |
| 22 | Sensitivity — not convenience — decides where a configuration variable's value is stored (`tier:` in the manifest): a true secret in the credential store, everything else in the deployment-configuration secret this repository writes; the classification is a property of the variable, not the environment. | `config/env-manifest.yaml`, `eng-tools/check-env-manifest.mjs` | — |
| 23 | The deployment-configuration secret and the credentials secret are separate secrets, always — a grant to read configuration must never transitively grant reading a database password or signing key. | `eng-tools/check-taskdef-boundary.mjs` | **Yes** — see below |
| 24 | `recipe.json` (the build artifact) carries an explicit `schema_version`; a reader with a newer major version must still be able to read every older builder's artifact — an absent version means the oldest version and stays permanently readable. Only additive/relaxing changes may share a minor version bump; anything that deletes a field, tightens a constraint, or changes a field's meaning requires a major version bump. | `packages/core/src/artifact-contract.ts`, `packages/core/contract/` | — |
| 25 | A newer artifact-schema major version that an orchestrator does not support must fail terminally and visibly (`artifact_schema_unsupported`) within minutes — never silently retry forever. | `packages/core/contract/` | — |
| 26 | The project is licensed Apache-2.0 — a single license, not a dual grant — and every user-facing surface naming the license must say Apache-2.0 and nothing else. | `LICENSE`, `package.json` | — |
| 27 | The published contract (status object, aggregated document, report artifact links) follows the Results SEP this project authors: verifier-keyed entries with no history field, `results_urls` entries carry `{type, url, sha256}` (and, for our own publishes, a `location` axis), and every document declares `schema`/`schema_version`. | `packages/core/src/registry.ts`, `packages/storage-layout/src/publish.ts` | — |
| 28 | A Batch job is dispatched by job-definition **family name**, never a revision ARN — `SubmitJob` resolves the latest ACTIVE revision itself. The `batch:SubmitJob` grant must list **both** ARN forms (`job-definition/<family>` and `…:*`): `:*` cannot match an unqualified ARN. | `packages/aws/src/batch.ts` | — |
| 29 | A service image reaches a running service through a per-environment **mutable alias tag**, never a digest written into a task definition: CI moves the tag, and the task definition and its pointer belong to Terraform. CI registers no service task definition. | `scripts/ci/promote-image-alias.sh`, `scripts/ci/roll-service-to-alias.sh` | — |
| 30 | The git ref decides the version, the release channel and the dist-tag; the committed manifest version is a placeholder, and exactly one reader owns that mapping. | `eng-tools/resolve-release-channel.mjs` | — |
| 31 | A trust input — the trusted image set, the Trusted Verifiers List, the published policy — changes by deploy only. No route mutates one in a running verifier, and `policy.json` stays byte-identical for the process's lifetime. | `config/verifier-policy.example.json`, `services/orchestrator-svc/src/modules/build-environments/` | — |

## The 3 rules with a full reason

**Rule 1 — builder zero-trust model.**
> `services/builder` executes attacker-influenced code. A submitter supplies a source archive and,
> for retroactive contracts, the container image to build it in. Whatever runs there must be assumed
> hostile. The obvious implementation gives the builder an AWS role that can read the staging bucket,
> write results, and update the job row — it is the component that knows the outcome, after all. That
> implementation makes a sandbox escape equivalent to full pipeline compromise: the attacker inherits
> S3 write access to the published result tree and can forge verification outcomes for contracts they
> do not control. Forged verification results are the highest-severity failure this service has,
> because the entire product is "you can trust this claim." The builder is structurally incapable of
> doing damage, rather than merely instructed not to — a presigned URL scoped to one key for one job
> is a capability, not an identity, and cannot forge a result regardless of how many such URLs it
> holds.

**Rule 16 — official-component dependency for composed build environments.**
> Rebuilding a legacy-toolchain contract requires a container carrying the exact toolchain that
> produced it. Official image coverage of that demand is a small head, not the body — serving the
> class at all means someone other than the platform's steward provides most environments. The
> question this settles is what qualifies an environment for a `verified` result: reproducibility,
> not publisher identity — every input pinned (image by digest, toolchain pieces by checksum,
> dependencies by lockfile), the environment recreatable by anyone from a published recipe, the
> recipe and checksums published with each result. Composition inputs must come only from on-chain
> metadata and official immutable sources — no submitter-supplied field may ever participate, because
> a submitter who can influence what counts as a trusted environment can make arbitrary source verify.
> Component provenance is required on top of reproducibility alone: the criteria exclude the
> irreproducible, but they do not exclude a faithfully pinned *malicious* toolchain, which could emit
> the deployed bytes regardless of source and forge a `verified` result.

**Rule 23 — configuration/credentials secret separation.**
> The deployment-configuration secret this repository's CI writes on every deploy and the
> credentials secret holding real passwords/keys must never collapse into one JSON blob per service,
> even though that would be cheaper to fetch. The objection is blast radius: any IAM grant that lets a
> principal read a harmless value (a timeout, a bucket name) must not, as a side effect, let that same
> principal read a database password or a signing key. CI is granted write on the configuration
> secret and nothing else — it holds no grant, read or write, on any secret holding a credential. This
> is what keeps a compromised deploy pipeline from becoming a compromised database or a forged
> signature, and it is the reason the two secrets are never merged for convenience even as the number
> of configuration entries grows.

## Superseded and folded decisions

A few ADR decisions were explicitly superseded by a later one, or fully absorbed by a rule above
with no independent content left:

- ADR-016's SSM-store and knob-stays-plaintext decisions, and ADR-006's decision 4, are superseded
  by rule 22/23 (ADR-025 in the original numbering).
- ADR-013's configuration-observability mechanism (HTTP route, boot log, digest) is fully visible by
  reading the code that implements it; no standing rule was extracted independently of rules 22/23.
- ADR-014's decisions are consolidated into rules 19–20; ADR-024 restates the same wire contract and
  is consolidated into rule 27.
- The ADR practice itself (the pull request is the record of a change) is a process decision, not a
  constraint on the shipped system, and has no code-location row.
