# ADR-016: Configuration lives in three tiers, and sensitivity — not convenience — decides which

> **Status**: Accepted 2026-08-12 (teki) · promoted from `Proposed` under the standing ruling that a `Proposed` status on shipped scope is a status nobody wrote back, and the state of the code decides it
> **Scope**: `config/env-manifest.yaml`'s `inject:` and the new `tier:`, `config/deploy/**`,
> `eng-tools/generate-deploy-env.mjs`, the ECS task definitions and the IAM the execution role needs
> **Amends**: [ADR-012](ADR-012-env-manifest-is-the-contract.md) — its `decided: Q1` recorded the
> current two-way `environment`/`secrets` split; this replaces it with three tiers
> **Depends on**: [ADR-006](ADR-006-terraform-owns-aws-infrastructure.md) (DevOps applies this),
> [ADR-013](ADR-013-config-contract-is-observable.md) (unaffected — see Consequences)
>
> ★ **Amended 2026-09-04 — decisions 2 and 3 superseded by
> [ADR-025](ADR-025-deployment-configuration-is-owned-by-this-repository.md)** (Proposed). Decision 1
> (tier is a property of the variable) and decision 4 (`check:env` enforces tier and mechanism agree)
> stand, and are what ADR-025 builds on. Two things move, both in directions this ADR itself marked as
> open: the store for tier `infrastructure` becomes Secrets Manager rather than SSM Parameter Store —
> decision 2 called that "the part most open to being overruled" and cheap to reverse, and DevOps
> proposed it originally — and tier `knob` stops being a boundary, because a template still carrying
> 117 plaintext variables still has to be written by whoever writes the template. This ADR's blast-radius
> objection to one JSON secret per service is *not* overruled: ADR-025 keeps configuration and
> credentials in separate secrets for exactly that reason. The "One unverified assumption" in
> Consequences is retired rather than answered — under one secret per service there is one fetch.
>
> **Applied to `dev`, and accepted afterwards (2026-08-12).** This block previously read "Proposed,
> not accepted … do not apply them until this ADR is accepted". That warning outlived the state it
> described: `AWS_PROFILE=scvs node eng-tools/diff-live-taskdefs.mjs --env dev` returns `live "dev"
> matches the contract`, and the artifacts it matches carry `ssm_parameters` — so the three-tier
> arrangement, including the SSM parameters the warning existed to prevent, is live. The acceptance
> ★ **Amended 2026-08-31 (ledger F149):** `eng-tools/diff-live-taskdefs.mjs` no longer exists. It became `check-service-cutover.mjs` (`edadc60`), which was itself retired with the rest of the task-definition cutover tooling once CI stopped registering task definitions (`60d0dcc`, ADR-021 P6). The evidence above stands as what was observed on 2026-08-12; the
> equivalent check today is `eng-tools/assert-config-contract.mjs --env dev`, which compares each
> service's boot-time `[config-contract]` report against the manifest rather than reading task
> definitions.
>
> ratifies what was applied rather than authorising something future; it is recorded that way because
> the two are different signatures. Environments other than `dev` are not evidenced here.

## Context

Every variable that is not a secret is set as plaintext `environment` on the task definition. DevOps
would prefer to manage configuration in Secrets Manager, and asked why not.

The first answer given was "most of these should not be in Secrets Manager", which was too blunt to be
useful. It bundled a correct point (a request timeout gains nothing from being a secret) with an
incorrect one (that the cost argument settles it), and it missed the case where DevOps is right.

Measured against the manifest as it stands, the 84 variables that reach a deployed service fall into
three groups, and they have genuinely different properties:

| | Count | Examples |
| --- | --- | --- |
| **Secrets** | 4 | `POSTGRES_USER`/`POSTGRES_PASSWORD`, `SCVS_ARWEAVE_WALLET_PRIVATE_KEY` |
| **Infrastructure identifiers** | 16 | `SCVS_PUBLISHER_BUCKET`, `SCVS_JOB_STATE_CHANGE_QUEUE_URL`, the Batch queue ARNs, the RDS endpoint |
| **Behavioural knobs** | 64 | `PORT`, `NODE_ENV`, timeouts, concurrency, the storage/arweave enums |

**The middle group is where DevOps is right and the original answer was wrong.** Those 16 are not
secrets, but they are not public either: together they are a map of the account's infrastructure —
bucket names, a queue URL carrying the account id, the RDS endpoint, Batch ARNs. Today anyone holding
`ecs:DescribeTaskDefinition` can read all of it in plaintext, and that is a **much broader grant** than
`secretsmanager:GetSecretValue`; this repo's own CI role holds the former and not the latter. Leaving
infrastructure identity behind the wider grant because it happens not to be a password is an accident
of history, not a decision.

Two things that were argued badly the first time and should not carry weight now:

- **Cost.** The objection assumed one secret per variable. The pattern already in use —
  `stellar-dev-rds-master` holding `username` and `password` as JSON keys — collapses that to roughly
  one secret per service, about **$1.60/month per environment**. Cost does not decide this.
- **Observability.** Moving a variable out of `environment` does **not** affect
  [ADR-013](ADR-013-config-contract-is-observable.md)'s report. ECS injects secrets into the process
  environment before the process starts, and the report reads `process.env`, so it behaves identically.

What does still argue against moving *everything* is narrower than cost, and applies only to the third
group: legibility (`describe-task-definition` currently shows what a service is configured with, and
`SCVS_WORKER_CONCURRENCY=1` has nothing worth protecting) and startup coupling (every task start would
depend on the secret store and the execution role's grants).

## Decision

**Sensitivity decides where a variable lives, in three tiers, declared in the manifest as `tier:` and
carried into the deployment by `inject:`.**

| `tier` | Where | `inject` | Why |
| --- | --- | --- | --- |
| `secret` | Secrets Manager | `ecs-secrets` | Needs rotation, resource policies, and the narrowest possible grant |
| `infrastructure` | SSM Parameter Store | `ecs-ssm` | Keeps infrastructure identity out of a plaintext task definition, at no cost |
| `knob` | Task definition | `ecs-environment` | Nothing to protect; legibility and a shorter startup path are worth more |

1. **Tier is a property of the variable, not of the environment.** A bucket name is tier
   `infrastructure` in `dev` and in production. The tier is declared once in the manifest; the
   mechanism follows from it.

2. **SSM Parameter Store, not Secrets Manager, for tier `infrastructure`.** ECS's `secrets`/`valueFrom`
   accepts both, so injection is identical. Parameter Store's Standard tier is free and still gives
   CloudTrail audit and no plaintext in the task definition — which is the entire benefit being sought
   here. Secrets Manager's extra capabilities (automatic rotation, cross-region replication, resource
   policies) are what tier `secret` needs and what tier `infrastructure` does not.

   **This is the part most open to being overruled**, and the cost of being wrong is small: if DevOps
   prefers one tool over two, changing tier `infrastructure` to Secrets Manager is a change to one
   field per entry and a regenerate. Tool uniformity is a legitimate reason and $1.60/month is not
   worth arguing about. What matters is that these 16 stop being plaintext.

3. **Tier `knob` stays in `environment`, and that is a boundary, not a default.** Moving it would buy
   nothing and cost two things: `describe-task-definition` would stop answering "what is this service
   configured with", and every task start would gain a dependency on the parameter store for values
   that are not sensitive. A variable moves out of `knob` when someone can say what it discloses.

4. **`check:env` enforces tier and mechanism agree.** A `tier: secret` entry must be
   `inject: ecs-secrets`; `tier: infrastructure` must be `ecs-ssm`; `tier: knob` must be
   `ecs-environment` or a Batch equivalent. The tier is the thing reviewed; the injection follows.

5. **This does not change what the manifest records.** Per ADR-012's `decided: Q2`, an identifier
   carrying an account id, region, or revision still has **no value recorded here** — moving it to
   Parameter Store changes where DevOps puts the value, not who owns it.

## Consequences

**Easier**

- Infrastructure identity leaves the plaintext task definition, so `ecs:DescribeTaskDefinition` stops
  being an infrastructure map. That is the concrete security gain and it is DevOps's point.
- One reviewable question per variable — "what does this disclose?" — instead of an implicit split
  nobody wrote down.
- Switching tier `infrastructure` between Parameter Store and Secrets Manager later is one field per
  entry, because the tier and the mechanism are separate fields.

**Harder / constrained**

- **The execution role needs `ssm:GetParameters`** on the new parameter paths, in addition to the
  `secretsmanager:GetSecretValue` it already has. A missing grant makes tasks fail to start with
  `ResourceInitializationError`, which is at least loud — unlike the failure modes this repo keeps
  finding.
- **A second store to look in.** Debugging a service's configuration now means the task definition
  *plus* Parameter Store. ADR-013's endpoint mitigates this: it reports effective configuration
  regardless of where a value came from, which makes it more load-bearing than before.
- **Startup gains a dependency** on Parameter Store for 16 values. Small, but non-zero, and it is the
  reason tier `knob` is not migrated: the same argument at 64 more variables would not stay small.
- **A migration with an ordering constraint.** The parameters must exist before a task definition
  references them, or the service fails to start. This is DevOps's to sequence; the artifacts in
  `config/deploy/**` describe the target state, not a safe intermediate one.
- **One unverified assumption**, flagged rather than asserted: whether ECS batches multiple
  `valueFrom` lookups that share one secret or parameter path into a single API call. If it does not,
  16 individual lookups add measurable latency to every task start. Worth measuring before extending
  this pattern further, and a reason not to treat "move more" as automatically better.

## Alternatives considered

- **Everything in Secrets Manager, as DevOps proposed.** Rejected only for tier `knob`, and on
  legibility and startup coupling rather than cost. For tier `infrastructure` the proposal is adopted;
  the only disagreement is the store, and that one is cheap to reverse.
- **Leave everything as it is.** Rejected: it leaves infrastructure identity readable by a grant that
  exists for an unrelated purpose, and it leaves the split undocumented, so the next variable lands
  wherever the last one did.
- **One JSON secret per service holding everything.** Attractive for cost and for a single fetch, but
  it makes the whole configuration one blast radius: any grant to read the timeout also reads the
  password. Tiering is the point.
- **Encrypt tier `infrastructure` with a CMK in Parameter Store (`SecureString`).** Not rejected, but
  not decided here — it adds `kms:Decrypt` to the execution role and a key to manage for values that
  are sensitive-ish rather than secret. Revisit if these ever leave the account boundary.

## References

- [`config/env-manifest.yaml`](../../config/env-manifest.yaml) — `tier:`, and `decided: Q1` which this amends
- [`config/deploy/README.md`](../../config/deploy/README.md) — what DevOps reads
- [ADR-012](ADR-012-env-manifest-is-the-contract.md) · [ADR-013](ADR-013-config-contract-is-observable.md) · [ADR-006](ADR-006-terraform-owns-aws-infrastructure.md)
