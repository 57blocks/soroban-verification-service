# ADR-006: Terraform owns AWS infrastructure; this repo ships images and a contract

> **Status**: Accepted (2026-07-29) · **decision 4 partially superseded by
> [ADR-025](ADR-025-deployment-configuration-is-owned-by-this-repository.md)** (Proposed 2026-09-04)
> **Scope**: `infra/`, the deployment surface of all four services, `docker/`, `.github/workflows/`
> **Supersedes**: the infrastructure-ownership half of ADR-001
> (`infra/cdk/lib/` as "one stack group per concern"). ADR-001's *service* boundaries stand unchanged.
>
> ★ **Amended 2026-09-04.** ADR-025 takes up the revisit this ADR's own *Alternatives considered*
> names — "If deployment velocity through DevOps becomes the bottleneck, this is the alternative to
> revisit" — and moves deployment *configuration* into this repository. **Decision 4 no longer holds**:
> this repository's responsibility now extends past the pushed image digest to rendering and
> registering the task definition. Decisions 1, 2, 3 and 5 stand unchanged, as does everything this
> ADR says about *infrastructure* — ADR-025 explicitly forbids this repository creating AWS resources,
> which is the split-brain hazard this ADR rejected.

## Context

This repository carried `infra/cdk/` — six CDK stacks (network / storage / batch / services /
events / iam) written against the TRD's target topology. **It was never `cdk deploy`'d, not once.**
Meanwhile the AWS account this project actually runs in was built by DevOps with Terraform, in a
repository we do not own.

By 2026-07-29 the two had drifted far enough that the CDK code was actively misleading rather than
merely incomplete. Measured against the live account (`123456789012` / `ap-southeast-2`):

| `infra/cdk` said | The account actually has |
| --- | --- |
| CDK creates the VPC, 4 subnet groups, NAT, endpoints | `stellar-dev-vpc` with 5 subnets and a NAT already exist |
| Batch on x86_64 `m6i.large`, `maxvCpus: 8` | Spot Graviton `c6g/c7g/c8g.xlarge`–`.2xlarge`, `maxvCpus: 100` |
| Builder container: docker.sock volume only | **also requires** host `/tmp` at the identical container path, or DooD silently mounts an empty directory. (`XDG_DATA_HOME=/tmp` was required here too until the CLI path that followed it was retired — 2026-08-31.) |
| CDK creates the S3 bucket (two prefixes, `RemovalPolicy.DESTROY`) | `stellar-artifacts` / `stellar-scratch` exist and are DevOps-owned |
| CDK creates RDS Postgres + generated secret | `stellar-dev-postgres`, `stellar-dev-1-postgres`, secret `stellar-dev-rds-master` exist |
| CDK creates the SQS queue + EventBridge rule | `scvs-dev-batch-job-state-change` (queue **and** rule) exist, hand-made |
| Three services on `node:24-slim` placeholder images, zero environment variables | — nothing deployed |

Two of those rows are not cosmetic. Deploying `batch-stack.ts` as written produces a compute
environment that cannot run the builder image at all (wrong architecture) and a job definition whose
DooD rebuild fails in the confusing, silent way documented in
`docs/features/_ARCHIVED/aws-deployment/notes.md`. Deploying
`storage-stack.ts` creates a *second* bucket and a *third* database next to the ones already in use.

The choice was not "CDK or Terraform" in the abstract. It was: does this repository take over
infrastructure that another team already owns and operates, or does it stop pretending to own it?

## Decision

**AWS infrastructure is defined in Terraform, outside this repository. This repository owns
container images, application configuration, and a written contract that says what the
infrastructure must provide.**

Concretely:

1. **`infra/cdk/` is deleted.** Not archived in place, not left with a "do not deploy" comment. Code
   that has never run and no longer matches reality is a liability: it reads as authoritative to
   anyone who has not diffed it against the account. Its irreplaceable content — the IAM asymmetry
   rationale and the subnet-isolation requirement — moves into
   `docs/design/aws-deployment.md`, which is now what ADR-002,
   `SECURITY.md`, and `AGENTS.md` point at.
2. **`docs/design/aws-deployment.md` is the contract.** It states, per resource: what must exist,
   what already exists, which invariants are load-bearing, and the exact environment variable each
   service reads. It is normative for DevOps's Terraform and reviewed here like code.
3. **Resources DevOps already owns are referenced, never re-created or imported.** Terraform for this
   system reads the VPC, subnets, Batch job queue, ECR repositories, S3 buckets, and RDS instance as
   read-only data sources. We do not `terraform import` them: that would require DevOps to
   `state rm` from their side first, and until they did, two pipelines would fight over the same
   resources.
4. **This repository's deployment responsibility ends at a pushed image digest.** CI builds and
   pushes the builder image, the resident-service image, and the web image, and registers a new AWS
   Batch job-definition revision pinned to a digest (that last step is already live in
   `.github/workflows/deploy-builder.yml`). Rolling ECS services onto a new digest is a Terraform /
   DevOps action.
5. **No environment variable that identifies infrastructure is baked into an image.** Everything
   environment-specific arrives as container environment or a secret reference at task-definition
   level. The one build-time exception the code had — the web client's API base URL — is removed
   rather than tolerated, so one web image is valid in every environment.

The `dev` topology this contract describes (single shared ALB, path-routed; the web client on Fargate
behind that same ALB) is recorded in the contract itself, not here — it is an environment shape, not a
cross-cutting decision. That is also why this aside no longer enumerates what the environment does and
does not terminate: it used to say "no domain or TLS", which stopped being true the moment :443 was
added, and a stale detail here is worse than no detail at all.

## Consequences

**Easier**

- The docs stop lying. There is exactly one description of the target infrastructure, and it is
  prose that can be checked against `aws` CLI output rather than code that looks executable and is not.
- No cross-team resource fight. DevOps re-applies their Terraform whenever they like; nothing here
  claims ownership of what they created.
- One image per artifact, valid across environments. No rebuild because an ALB was recreated.

**Harder / constrained**

- **We cannot deploy end to end by ourselves.** Every infrastructure change is a hand-off: write the
  contract change, get DevOps to apply it. The critical path for "deploy this system" now runs
  through another team, and the plan in
  `docs/features/_ARCHIVED/aws-deployment/plan.md` is explicit about
  which phases we cannot finish.
- **Data-source references are an invisible dependency.** Nothing stops DevOps from renaming a subnet
  or deleting a bucket. There is no compile error for that — only a failed `terraform plan` on their
  side and a broken service on ours. The contract therefore names every referenced resource
  explicitly so a rename is at least greppable.
- **Drift will come back.** The reason `infra/cdk` rotted is that nothing compared it to the account.
  A prose contract has the same weakness. The mitigation is that the contract records the
  `aws` CLI commands that verify each claim, and the runbook makes running them a step — not that
  drift is now impossible.
- **We lose `cdk-nag`.** In practice we lose nothing: `cdk-nag` was never a dependency of
  `infra/cdk`, so CI's `cdk-nag` job only ever ran plain `cdk synth`. Policy scanning of the
  Terraform is DevOps's to add.

## Alternatives considered

- **Fix `infra/cdk` and deploy it, taking over the account.** Rejected: it requires DevOps to tear
  down or hand over a running Batch environment, an RDS instance, and two buckets other work already
  depends on. The engineering cost is not writing the CDK — it is the coordinated migration, for an
  environment whose value is that it already works.
- **Author Terraform here, in `infra/terraform/`, and apply it ourselves.** Rejected for now: two
  Terraform code bases with two states against one account is exactly the split-brain that made the
  CDK drift dangerous, only with locking behaviour to make it worse. If deployment velocity through
  DevOps becomes the bottleneck, this is the alternative to revisit — and it is a cheaper reversal
  than the previous option, because the contract doc is the input either way.
- **Keep `infra/cdk` as read-only reference.** Rejected: see decision 1. A stale artifact that
  *looks* runnable is worse than a deleted one, and its two genuinely valuable comments survive in
  the contract.
- **Create a parallel `scvs-*` environment that touches nothing DevOps owns.** Rejected: it doubles
  cost, and it contradicts reusing the existing buckets — which is what keeps the CI stellar-CLI
  cache and the verification artifacts in one place.

## References

- `docs/design/aws-deployment.md` — the contract itself: resource
  inventory, environment-variable contract, IAM boundaries, DooD invariants
- `docs/runbooks/aws-deployment.md` — how to build, push, apply, and
  smoke-test a deployment
- `docs/features/_ARCHIVED/aws-deployment/` — spec, plan, and what the live
  account inventory turned up
- [ADR-002](ADR-002-builder-holds-no-business-credentials.md) — the IAM asymmetry this contract must
  preserve
- [ADR-003](ADR-003-always-dispatch-builds-to-aws-batch.md) — why a deployment without a working
  Batch queue has no fallback path
