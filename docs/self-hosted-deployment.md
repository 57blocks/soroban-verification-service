# Self-hosted deployment guide — Verifier-only mode

> **Audience**: an operator standing up their own verifier in their own AWS account — not this
> project's reference deployment. If you are looking for how *this operator's* environments are run
> day to day, that is internal operational material and is not what this document is.
> **Scope**: **Verifier-only mode** — your own identity, your own trust policy, your own published
> result root. Query-only mode (aggregating other verifiers without rebuilding anything) and Full
> stack are different deployment shapes; see [`docs/specs/configuration.md`](specs/configuration.md)
> §10 for the mode table. This guide does not cover either.
> **Authority for the architecture**: [rule 8 of `docs/invariants.md`](invariants.md) and
> [`docs/specs/configuration.md`](specs/configuration.md) describe the target shape this project
> itself runs in; this document is "how a stranger builds an equivalent shape in their own account,"
> not a copy of either. Where this guide is silent on a detail, that document's *pattern* — not its
> specific IDs — is the thing to follow.

## 0. What "Verifier-only" actually commits you to running

Three services, plus the sandbox they dispatch into:

- **verification-svc** — the public HTTP surface: accepts a submission, returns job status, serves an
  SSE status stream.
- **orchestrator-svc** — internal only, no public listener. Polls for queued jobs, dispatches the
  rebuild, computes the verdict, publishes the result.
- **builder** — runs *inside* the batch job your orchestrator dispatches. The only place submitted
  source is ever executed. Holds no business AWS credentials by design — not a hardening choice you
  can loosen, a structural property this guide's §3 makes non-negotiable.
- Your own object storage (a scratch bucket, a results bucket) and your own Postgres.

You will also need a batch-compute mechanism to run `builder` in. This project's own deployment uses
AWS Batch; **there is currently no non-AWS batch/queue adapter in this codebase at all** —
`orchestrator-svc` imports AWS Batch and SQS clients directly. If your target is not AWS, that adapter
is work you take on, not something this guide walks you through.

**What does not exist yet, so this guide cannot point you at it:**

- **No Helm chart.** `docker/docker-compose.yml` exists for local development; there is no packaged
  Kubernetes deployment.
- **No database-free query path.** If you also want to aggregate other verifiers (Query-only mode),
  that mode's "no database" property is an aspiration the TRD explicitly declines to commit to today —
  plan on running Postgres for it too.

This guide walks the shape this project actually runs in production — Verifier-only on AWS — because
that is the one path that is real today. Anything else is a port you're doing yourself, starting from
the same architecture document.

## 1. Prerequisites

- An AWS account you control, and the ability to provision VPC, S3, RDS, ECS/Fargate, AWS Batch, SQS,
  ECR, IAM, and (if you want your own hostname in front of the results tree) CloudFront + ACM.
- Terraform (or the IaC tool of your choice — this project uses Terraform, per `docs/invariants.md`
  rule 8, but nothing about the shape below requires it specifically).
- Docker with multi-platform build support if you intend to build the container images yourself rather
  than adapting this repository's.
- A naming convention you will apply consistently. This project's own convention is
  `{project}-{environment}-{type}` (for example `sv-dev-scratch`, `sv-staging-postgres-verify`) —
  **the convention matters more than the literal prefix**: nothing downstream in this codebase parses
  your resource names, but a missing environment segment on a resource meant to be per-environment is
  the single most common self-inflicted incident in this style of deployment (two environments racing
  over one resource). Pick a convention, including an environment segment on everything that is not
  deliberately shared, and hold to it.

## 2. What you provision, and why each piece is shaped the way it is

The summary that matters for a first deployment:

| Piece | Shape | Why |
| --- | --- | --- |
| VPC + subnets | Public subnets for anything internet-facing (your API's load balancer), private subnets for services, data, and the batch fleet | `orchestrator-svc` takes no inbound traffic at all and should never sit behind a load balancer target group |
| Object storage | Two buckets minimum: a **scratch** bucket (presigned-PUT uploads, short-lived) and a **results** bucket (your published result root — see §4) | Keeping them separate means your public result tree's access policy is never accidentally as permissive as your upload scratch space's |
| Batch compute | At least one job queue + compute environment for the builder fleet | This is where untrusted rebuilds run — see §3 before provisioning its IAM |
| Postgres | One instance is enough to start (verification-svc + orchestrator-svc share it) | If you later also run Query-only mode, that reads its own instance — the two are kept apart deliberately |
| SQS queue | One queue for Batch job-state-change events, fed by an EventBridge rule watching your Batch job queue | This is how `orchestrator-svc` learns a rebuild finished — it does not poll Batch directly |
| ECR repositories | One each for the builder image and your resident-service images | Push commit-SHA-digest tags; do not rely on a mutable `:latest` — see §5 |

This table is AWS-shaped, per §0. For a service-by-service breakdown of what each one functionally
needs (compute, network, database, object storage, async job execution, secrets) independent of any
one vendor's naming — and, just as importantly, **which of those you can freely swap for another
provider and which are already locked to a specific vendor SDK in the application code** — see
[`docs/infrastructure-requirements.md`](infrastructure-requirements.md). Read it before you assume a
piece is portable just because it's "just a database" or "just object storage."

## 3. The one invariant you must not relax: the builder holds no business credentials

This is [rule 1 of `docs/invariants.md`](invariants.md)'s decision, and it is not
optional hardening — it is the reason a sandbox escape in the rebuild container does not become a
compromise of your database, your credentials, or your published results. Concretely, when you
provision the builder fleet's IAM:

- **The Batch job definition sets no `jobRoleArn` at all.** The container that runs submitted source
  has no assumable role — not a narrowly scoped one, none.
- **The Batch instance/execution role grants ECR pull and CloudWatch Logs only.** No S3, no
  Secrets Manager, no RDS, no SQS, no `batch:SubmitJob`.
- **The container itself runs hardened**: no Linux capabilities, no new privileges, no network,
  read-only root filesystem, non-root user, a writable mount scoped to exactly the build output.
- **The builder does not decide the verdict.** It reports what happened; the trusted side
  (`orchestrator-svc`) re-hashes the uploaded artifact itself and compares against the deployed hash.
  Never let a self-hosted deployment trust a hash the builder claims over one you compute yourself.

If you provision anything more permissive than this for the builder fleet — even "just for now, while
debugging" — you have built a different, weaker system than the one this guide describes. Verify it:
after a rebuild runs, confirm from the batch job's own assumed-role check (or lack of one) that it
cannot reach your database or your secrets. Do this on your own deployment before trusting it with real
submissions.

## 4. Configuring the services

Every value a resident service needs is declared in
[`config/env-manifest.yaml`](../config/env-manifest.yaml) — read it as documentation of what you must
supply, not as something to copy verbatim (it also names this project's own account and resource
values, which are not yours). Three categories, by sensitivity:

- **`secret`** — credentials (database passwords, archive-provider keys). Put these in a secrets
  manager your services read at boot, never in plaintext environment variables.
- **`infrastructure`** — values that name a resource (a bucket name, a queue URL, a host). These come
  from what you provisioned in §2.
- **`knob`** — plain configuration (feature flags, numeric limits) safe as literal environment
  variables.

Two things worth knowing before you configure anything:

- **`orchestrator-svc` and any query-facing service must receive identical publisher/storage
  configuration** — the same result-storage backend, region, and public result-root URL. A mismatch
  between what one service writes with and what another reads with does not fail loudly; it shows up
  as an empty or missing result where one should exist.
- Run whatever validation your own fork of `pnpm run check:env` equivalent gives you before first
  boot — this project's version cross-checks the manifest against what the code actually reads and
  fails on any variable present in one place and not the others. Do not skip this step even if it
  feels redundant; a missing variable failing loudly at boot is much cheaper than one failing silently
  in production.

## 5. Building and deploying the images

Three Dockerfiles under `docker/` for Verifier-only mode (a fourth, `composer.Dockerfile`, is only
needed if you also serve cli-legacy targets — out of scope here):

- **`docker/builder.Dockerfile`** — the sandbox image. Build it **twice, once per architecture**
  (`--platform linux/arm64` and a separate `--platform linux/amd64` build), not once as a combined
  multi-platform build. A combined build's digest points at an OCI index (the image plus attestation
  manifests), not the plain image — and §3/§6 both depend on pinning a real image digest, which a
  multi-platform build does not give you directly.
- **`docker/service.Dockerfile`** — shared by `verification-svc`, `orchestrator-svc`, and `query-svc` if
  you run it; one image, three different startup commands. Before building it, fetch or build the
  Stellar CLI binary it bakes in (see `scripts/ci/fetch-or-build-stellar-cli.sh` in this repository for
  the reference approach — `verification-svc`'s preflight and `orchestrator-svc`'s chain reader both
  spawn it at runtime). **This project's own CI currently builds this image arm64-only** — a temporary
  state of the CI pipeline, not a requirement of the image itself. Building it for amd64 is not
  something this guide walks you through; check whether that limitation still holds before assuming
  you can run this on an amd64 host.
- **`docker/web.Dockerfile`** — only if you're running a console.

**On every build, whatever your CI tool**: pass `provenance: false` and `sbom: false` (or your
builder's equivalent) — without them, the digest your build produces is the OCI index's, not the
image's, and the digest-pinning this guide keeps insisting on stops meaning what you think it means.

**Tag images by commit-SHA digest, never `:latest`.** A running service pointed at a mutable tag that
no longer resolves to a real image is a class of outage this project has already hit once; don't
repeat it. Pin the digest your task definition references.

If your ECR (or equivalent) repository is immutable, know that before your first push — re-pushing an
existing tag fails, which is a feature, not friction.

## 6. Verifying your deployment actually works

1. Submit a contract you know is deployed on a public network (testnet is the safer first try) through
   your `verification-svc` endpoint.
2. Poll job status (or watch the SSE stream) until it reaches a terminal state.
3. Confirm a result actually landed in your results bucket at the expected key, and that it is
   reachable over HTTPS at whatever public host you've put in front of that bucket — this is your
   **result root**, and it is the thing the rest of the ecosystem will actually read, not any API
   response.
4. Confirm your `verifier-manifest.json` is present at your result root and its URL templates actually
   resolve to results you serve — a manifest pointing at templates that 404 is worse than not
   publishing one (see [`docs/verifier-onboarding.md`](verifier-onboarding.md) §2 for what "correctly
   shaped" means here).
5. Re-run the credential check from §3. Do this on a schedule, not just once at launch — IAM policies
   drift as infrastructure gets edited.

## 7. Where to go next

- If you intend for other verifiers or aggregators to eventually list you,
  [`docs/verifier-onboarding.md`](verifier-onboarding.md) covers what "being discoverable" actually
  requires — there is no registration step, but there is a self-description you need to get right.
- [`docs/specs/configuration.md`](specs/configuration.md) is the fuller reference this guide
  summarized; read it if you need more detail on any one piece.
- This project's own operational runbooks describe how *this* operator runs *its* environments day
  to day. They live in the internal repository this project was exported from and are written
  against a specific account, so they are not a drop-in playbook for yours — but the failure modes
  they document (a misconfigured publisher variable, a stuck build, an image-trust change) are the
  kind worth planning for once you're operating for real, even without the specific document.
