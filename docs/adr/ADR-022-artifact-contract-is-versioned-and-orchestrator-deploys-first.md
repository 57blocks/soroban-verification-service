# ADR-022: The build-artifact contract is versioned, and the orchestrator deploys before the builder

> **Status**: Proposed (drafted 2026-09-01) — drafted by an agent, awaiting a human signature per
> `../../AI_COLLAB.md`'s role table ("may draft and propose; never adopts
> unilaterally"). **Do not merge unsigned.**
> **Scope**: `BuildArtifact`/`recipe.json` and everything it nests, the order in which `deploy.yml` and
> `deploy-builder.yml` may reach an environment, and what happens to a rebuild whose artifact cannot be
> read.
> **Depends on**: ADR-001 (the two ends deploy
> separately — this ADR is the compatibility rule that independence requires),
> [ADR-005](ADR-005-dto-ownership-follows-use.md) (one class, not two copies),
> ADR-020 (dispatch resolves the family's newest revision,
> which is why a builder registration takes effect immediately),
> [ADR-008](ADR-008-rebuild-and-verdict-are-separate-entities.md) (one rebuild serves every attached
> job, which is what makes one unreadable artifact strand many)
> **Touches a sensitive surface**: the wire contract with the untrusted sandbox, and the Batch job
> definition.

## Context

`recipe.json` is the only channel out of the build sandbox, and its two ends are separate deployable
units: the builder is a Batch job definition written by `deploy-builder.yml`, the orchestrator an ECS
service written by `deploy.yml`. ADR-001 accepted that separation deliberately. What it never stated is
the compatibility rule that makes separation survivable, and without one the contract has failed twice
in three weeks, in opposite directions:

| Date | Direction | Symptom |
| --- | --- | --- |
| 2026-08-10 | old builder, new orchestrator | every rebuild `batch_job_failed_no_artifact`; the materialiser rejected the document it was handed, so no `recipe.json` existed to explain it |
| 2026-09-01 | new builder, old orchestrator | job `6429588a-…` stuck `running` for hours on a build that had SUCCEEDED with a complete artifact |

The second is the one that shows why a convention is not enough. `deploy-builder.yml` registered one
image into **both** environments' job-definition families while `deploy.yml` deployed **one**
environment's services, so "deploy to dev" silently moved staging's builder too. Staging's orchestrator
stayed on a commit that required `reference_alignment.base_commit`, which had since been replaced with
`version`; `parseDto` threw; the SQS queue had `RedrivePolicy: None` so the message came back every 30
seconds; `RebuildReconcilerScheduler` retried every 60. Nothing was terminal, so nothing was visible,
and every job attached to that rebuild stayed in `comparing` — which `getActiveJobForTarget` counts as
active, making those contracts unverifiable for as long as it lasted.

The 2026-08-10 mitigation added a `main`-only trigger, which addressed *which commit* deploys. Neither
incident was about that. Both were about two deployable units disagreeing about one document with no
rule saying who must move first.

## Decision

### 1. `recipe.json` carries `schema_version`, as `MAJOR.MINOR`

`BUILD_ARTIFACT_SCHEMA_VERSION` in `packages/core/src/artifact-contract.ts` is what the code writes and
what it reads. `buildRecipeArtifact` stamps it on every artifact, whatever the outcome.

It is `@IsOptional()` on the DTO and unconditional in the producer, and that asymmetry is the point.
Producer and consumer need different rules — the same split `registry.ts` already makes between
`RegistryStatusObject`'s `@Equals` and `PeerRegistryStatusObject`'s `@SupportedSchemaMajor` — but
ADR-005 keeps this shape as **one** class, so the two rules cannot be two classes. An absent
`schema_version` therefore means `0.0`, "written before this ADR", and stays readable forever; the
producer's obligation is asserted by a test rather than by a validator.

### 2. A newer reader reads every older builder's artifact. Permanently.

DTO evolution may **add optional fields** and **relax validation**. It may not delete a field, tighten
one, or change what one means. A genuinely breaking change needs a MAJOR bump *and* a dual-write
transition — never a bump alone.

This is what makes "deploy the orchestrator first" safe in every partial-deploy combination, including
an environment left behind for weeks.

### 3. The other direction is not compatible, and must fail visibly in minutes

An orchestrator reads `schema_version` **before validating anything else**. A MAJOR above its own is
recorded as terminal `cli_failure` / `artifact_schema_unsupported`, naming both versions. A document it
cannot parse at all is terminal `cli_failure` / `artifact_unreadable`.

Terminal, not retried. The failure being *invisible* is what made the incident hours long rather than
minutes; a rebuild that fails with a reason costs one submission and tells you what to do.

A higher MINOR is readable — additive by construction. Which means **widening a value set requires a
MAJOR bump even though it is a relaxation**: relaxing an `@IsIn` is backward-compatible for a new reader
and rejected outright by an old one, and that asymmetry is the single easiest way to break this contract
while believing rule 2 was honoured.

### 4. Deployment order is fixed: orchestrator first, builder follows, enforced by a gate

`deploy.yml` records the contract version an environment supports into
`/scvs/<env>/deployed/orchestrator-contract-version` after that environment's rollout.
`deploy-builder.yml` reads it before registering, and **skips any environment whose orchestrator has not
recorded support for the version this image writes** — leaving it on its previous builder, which rule 2
guarantees is readable. A skip fails the run: a divergence between environments is either chosen or
forgotten, and both need to be seen.

The parameter is app CI's own output, not a field in Terraform's `/scvs/<env>/ci/descriptor`. One
document, one writer.

### 5. Each environment's builder image lives in its own repository

`deploy-builder.yml` builds once and pushes that image to **every** environment's own ECR repository,
registering each family from its own. Before this, `sv-staging-builder` held zero images and staging's
build hosts pulled from `sv-dev-builder` on every job, which is the mechanism by which staging's builder
followed dev's with no way to hold one back.

### 6. The contract's shape is frozen in the repository, and a change to it is a version change

`packages/core/contract/` holds two things, checked by `src/artifact-contract-test.ts` in
`pnpm run test`:

- **`corpus/v<version>/`** — documents builders actually wrote. The current DTO must parse every one, at
  every version. This is rule 2 as a runnable assertion, and it is what catches a tightened field or a
  narrowed value set regardless of what else a PR changed.
- **`build-artifact.v<version>.json`** — a derived description of every shape, property, and whether
  absence is rejected. Any difference from the current version's snapshot fails the build with "bump the
  version and regenerate", so a wire change cannot merge without both.

A snapshot is **frozen once merged**. The check cannot tell a regenerated file from a hand-edited one,
so this last part rests on review: a diff to an existing version's snapshot, in a PR that did not
introduce that version, must be refused. Deleting a version's snapshot and corpus is how a retired
version is retired, and is legitimate only once no deployed orchestrator reads it.

## Consequences

**A builder deploy can now be red on purpose.** An environment behind on its orchestrator gets a
skipped registration and a failed run. That is the intended reading of "these two environments have
diverged", and the run summary says which environment and what to do.

**The first run after this lands skips both environments.** Neither has recorded a contract version yet,
so the sequence is: merge → `deploy.yml` runs on push and records dev → re-run `deploy-builder.yml` →
dispatch `deploy.yml` to staging → re-run `deploy-builder.yml`. This is the fixed order doing exactly
what it says, once, from a standing start.

**One deliberate cross-environment IAM grant.** dev's CI role gains ECR push on staging's builder
repository, because the account-wide workflow assumes dev's role. ADR-021 P6 removed every other
cross-environment reach from that role. This one is accepted because the alternative it replaces is
worse: staging's build hosts pulling dev's images at runtime, permanently, rather than dev's CI writing
one repository at deploy time.

**A `cli_failure` is charged to the submitter's job.** An `artifact_schema_unsupported` rebuild fails
every attached job, and those jobs did nothing wrong. Accepted: a stale `cli_failure` is re-opened for
the next job that attaches (`requeueStaleCliFailure`), so the cost is one submission, against a wedge
that previously had no end at all.

## Rejected

- **Make `schema_version` required on the DTO.** It reads as the stronger rule and breaks rule 2 on the
  first document: every artifact already in S3 lacks the field, including the one the recovery deploy
  had to read. A required field would have made the fix unable to fix the incident.
- **Trigger `deploy-builder.yml` from `deploy.yml`'s completion (`workflow_run`).** Literally implements
  "builder follows orchestrator" and removes the re-run. It also drops the `paths:` filter, runs from the
  default branch regardless of what completed, and makes a builder deploy unreachable when a services
  deploy is skipped — trading a visible re-run for a coupling that is hard to reason about. The gate
  gives the same safety without owning the trigger.
- **Compare against the real deployed orchestrator by checking out its commit in CI.** The faithful
  version of rule 6's first half. It needs the deployed commit in SSM, a dependency install per
  version, and AWS credentials in a PR check — where a fork PR has none. The corpus gets the same
  property from documents already in the repository.
- **One counter instead of `MAJOR.MINOR`.** Fewer moving parts, and no way to say "additive" — which is
  the distinction that lets a MINOR bump deploy in any order.
