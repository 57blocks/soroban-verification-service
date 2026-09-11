# ADR-025: Deployment configuration is owned by this repository and delivered through Secrets Manager

> **Status**: **Accepted 2026-09-04 (Sander Heng)** — drafted by an agent at the operator's
> direction and signed after the contract side landed, per
> `../../AI_COLLAB.md`'s role table ("may draft and propose; never adopts
> unilaterally").
>
> The signature **ratifies what was applied rather than authorising something future**, and it is
> recorded that way because the two are different acts — the same distinction ADR-016's header draws.
> What was already true when it was signed: PR #267 merged the contract side (the manifest, the
> generator, and the three new tools), and `soroban-aws-infrastructure` PR #32 was applied to both
> environments, so `dev` and `staging` serve CI descriptor v3 and
> `pnpm run deploy:check-descriptor` passes against each.
>
> What is **not** yet built, and what a reader should not assume from this status: `render-taskdef.mjs`,
> the `deploy.yml` changes that would register a task definition, and the CI role's
> `ecs:RegisterTaskDefinition` / `iam:PassRole` / `secretsmanager` grants. Until those exist no task
> definition is rendered here, and **decision 5's boundary check must be wired into the workflow before
> anything in this repository registers a Batch job definition**.
> ─────────────────────────────────────────────────────────────────────────────────────────────
> ⚠ **The paragraph above is stale as of 2026-09-08, and its staleness has already cost a decision.**
> `render-taskdef.mjs` exists, the `deploy.yml` changes exist, and both are wired into the deploy job
> (`deploy.yml` lines 417/437 for the ECS services and 664/674 for db-migrate); the CI role's
> `secretsmanager` grants on `scvs/*/config-*` are live in both environments and were measured on
> 2026-09-08. Decision 5's boundary check is wired and runs before every register. A reader who takes
> the "not yet built" list at face value concludes this repository cannot inject configuration, which
> is the opposite of what it now does. **Left in place rather than rewritten**, because amending an
> Accepted ADR is a human act (`AI_COLLAB.md`) — this note proposes the correction.
>
> ★ **Amended 2026-09-08 by Song Bai — a third category decision 1's table does not have.**
> `../features/retention-and-pseudonymisation/design.md`
> §5 proposes **a secret nobody writes**: `tier: infrastructure` + `generate:`, minted by
> `sync-secrets.mjs` into the config secret CI already owns and preserved verbatim on every later
> deploy. It exists because the two-tier table forces a genuinely secret value that no human needs to
> author into the credential store, and a new credential costs a Terraform pull request and an apply
> per environment — CI is `implicitDeny` on every secretsmanager action for one, and the execution
> role grants credentials one ARN at a time while reading `scvs/<env>/*/config-*` by wildcard. It
> trades against decision 2's blast-radius argument, and that trade — not the mechanism — is what was
> signed: design.md §5 states it, the threat model it rests on (an attacker holding the abuse_control
> rows does not thereby hold CI, and one who holds CI can deploy code that logs raw addresses anyway),
> and the fallback if it is ever reversed. `check:env`'s check J enforces the shape.
> ─────────────────────────────────────────────────────────────────────────────────────────────
> **Scope**: `config/env-manifest.yaml`'s `tier:`/`inject:`/`source:`, everything under
> `config/deploy/**`, `eng-tools/generate-deploy-env.mjs` and three new tools,
> `.github/workflows/deploy.yml` / `deploy-builder.yml` / `deploy-composer.yml`, the CI deploy role's
> IAM, and the `aws_ecs_task_definition` / `aws_batch_job_definition` resources in
> `soroban-aws-infrastructure`.
> **Supersedes**: [ADR-006](ADR-006-terraform-owns-aws-infrastructure.md) decision 4 (this
> repository's deployment responsibility ends at a pushed image digest) ·
> [ADR-012](ADR-012-env-manifest-is-the-contract.md)'s `decided: Q2` (no value recorded for a
> non-`literal` entry) · [ADR-016](ADR-016-configuration-lives-in-three-tiers.md) decisions 2 and 3
> (SSM Parameter Store for tier `infrastructure`; tier `knob` stays in plaintext `environment`)
> **Leaves standing**: ADR-006 decisions 1, 2, 3 and 5 · ADR-016 decision 1 (tier is a property of the
> variable) and decision 4 (`check:env` enforces tier and mechanism agree) · all of ADR-012's other
> decisions · [ADR-013](ADR-013-config-contract-is-observable.md), which this makes more load-bearing ·
> ADR-021's `:deployed` alias, which is
> orthogonal to who writes the template
> **Touches a sensitive surface**: the ECS/Batch task definition, the CI deploy role's IAM grants, and
> — critically — [ADR-002](ADR-002-builder-holds-no-business-credentials.md)'s trust boundary.

## Context

ADR-006 drew the line at a pushed image digest: this repository owns images and a written contract,
DevOps owns everything the contract describes. ADR-021 completed that reading by removing CI's last
write to a task definition. The result is the arrangement running today:

```
config/env-manifest.yaml ──generate:deploy-env──► config/deploy/<env>/<svc>.json
                                                          │  (a specification, no values)
                                                          ▼  human handoff
                                                    Terraform ──► task definition
```

It works, and ADR-006's own Consequences section named its cost before it was felt:

> **We cannot deploy end to end by ourselves.** Every infrastructure change is a hand-off … The
> critical path for "deploy this system" now runs through another team.

That cost is now the binding one. A variable's name, type, default, failure mode, and the code that
reads it all live here; only the act of putting the value in front of the process lives elsewhere.
Adding one environment variable is a four-file change in this repository plus a wait on another
team's apply. `check:env` makes forgetting a file loud, but nothing makes th1e wait shorter.

ADR-006 anticipated this exact reversal and named the condition for it:

> **Author Terraform here … Rejected for now** … If deployment velocity through DevOps becomes the
> bottleneck, this is the alternative to revisit — and it is a cheaper reversal than the previous
> option, because the contract doc is the input either way.

This ADR takes that revisit, and takes it one step further than ADR-006 sketched: rather than a
second Terraform state fighting the first over one account — the split-brain ADR-006 rejected — the
deployment configuration moves out of Terraform's state entirely, into a store whose contents are
data rather than infrastructure.

**Two facts from the account decide the mechanism.** First, the five secrets that hold this system's
genuinely sensitive values already exist and already match what the manifest declares:

| Secret | Holds | Manifest `secret_ref` |
| --- | --- | --- |
| `sv-<env>-rds-master-verify` | `username`, `password` | verification-svc, orchestrator-svc, db-migrate |
| `sv-<env>-rds-master-query` | `username`, `password` | query-svc |
| `try-arweave/private-key` | the key itself, not JSON | orchestrator-svc |

So the `tier: secret` variables need no migration at all. What moves is everything else. Counted from
the generated `config/deploy/dev/` artifacts, per environment:

| tier | Distinct variable names | Service-entries (= `valueFrom` entries to render) |
| --- | --- | --- |
| `secret` | 3 | 9 — already in Secrets Manager, untouched |
| `infrastructure` | 17 | 32 |
| `knob` | 85 | 117 |

The right-hand column is the one that sizes the mechanism: **149 injected entries per environment**,
because a variable read by three services is three entries. Second, ECS's `secrets`/`valueFrom`
accepts `<arn>:<json-key>::`, and multiple entries sharing one secret resolve against one fetch. That
retires the one measurement ADR-016 flagged and never took:

> **One unverified assumption** … whether ECS batches multiple `valueFrom` lookups that share one
> secret or parameter path into a single API call. If it does not, 16 individual lookups add
> measurable latency to every task start.

Under one-secret-per-service the question does not arise, which is what makes moving 149 entries
tractable where ADR-016 correctly judged it was not across 149 separate parameters.

## Decision

**This repository owns deployment configuration end to end. It writes the values into Secrets
Manager, renders the task definition, and registers it. Terraform keeps the infrastructure those
values name.**

1. **Two tiers, one store.** `tier:` survives as the reviewable statement — "what does this
   disclose?" — but now selects a *secret*, not a store:

   | `tier` | Lands in | Written by |
   | --- | --- | --- |
   | `secret` | the existing `sv-<env>-rds-master-*` / `try-arweave/private-key` | DevOps, once, already done |
   | `infrastructure`, `knob` | `scvs/<env>/<service>/config`, one JSON, one key per variable | this repository's CI, every deploy |

   **This applies to the resident ECS services only.** A Batch job definition — builder and composer —
   keeps its variables plaintext in the job definition and gets no config secret. Reading one requires
   `secretsmanager:GetSecretValue` on the execution role, and the builder's roles are scoped to zero
   business permissions by ADR-002 (`aws-deployment.md` §5.1 calls that asymmetry load-bearing). Its 17
   variables are sandbox limits — CPU, memory, pids, a non-root uid — with nothing to protect and
   everything to lose by making the sandbox reach a credential store in order to start.

   `inject:` collapses `ecs-ssm` into `ecs-secrets`; `check:env`'s check J is updated to match, so
   ADR-016 decision 4 keeps holding over the new mapping. SSM Parameter Store is retired from the
   configuration path — the `/scvs/<env>/ci/descriptor` parameter stays, and is the one thing SSM
   still carries.

2. **`config` and `secrets` are separate secrets, and stay separate.** ADR-016 rejected
   one-JSON-secret-per-service on blast radius — "any grant to read the timeout also reads the
   password" — and that objection is correct and survives. It is answered by splitting rather than by
   two stores: the grant to read configuration must not transitively read a database password.
   **CI is granted write on `scvs/*/config-*` and nothing else.** It holds no grant, read or write, on
   any secret holding a credential.

3. **A value carrying an account id, region, or revision is still not committed.** ADR-012's
   `decided: Q2` exists because a stale identifier that reads as authoritative is what killed this
   repo's previous infrastructure description. That failure mode is unchanged by this ADR, so the rule
   is preserved by redirecting rather than relaxing: such an entry gains
   `value_from_output: <json-path>` and CI resolves it at deploy time from
   `/scvs/<env>/ci/descriptor` — Terraform's own outputs, written by the team that owns them, read
   fresh on every deploy. **Nothing that can go stale is committed to this repository.** What
   `decided: Q2` actually forbade — a recorded value — remains forbidden; what it implied — that
   therefore only DevOps can perform the injection — is what this ADR reverses.

4. **CI renders and registers the task definition.** `render-taskdef.mjs` composes the full document
   from the manifest plus the descriptor; `deploy.yml` registers it and points the service at that
   revision. `environment[]` becomes empty for the resident services. This restores to CI the write
   ADR-021 removed — see *On reversing ADR-021's direction* below, which is the part of this ADR most
   open to being overruled.

5. **The builder's `forbidden` list becomes a mechanical gate, in the same change.** Today
   [`config/deploy/README.md`](../../config/deploy/README.md) says of it:

   > This list is normative for the Batch job definition, and **CI cannot check it** — the job
   > definition is Terraform's. It is the one place in this contract that needs a human on your side.

   Both halves of that sentence stop being true at once, and only one of them stops being true by
   accident. `check-taskdef-boundary.mjs` runs between render and register, and fails the deploy if a
   rendered builder document names any `forbidden` variable, carries a `jobRoleArn`, or references a
   secret belonging to another service. **This is not a follow-up.** ADR-002's boundary is currently
   guaranteed by repository topology — CI cannot write the job definition — and this ADR removes that
   guarantee. Replacing it with an executable assertion in the same change is the condition on which
   the rest of this decision rests; without it the trust boundary degrades from structural to
   procedural, which is the one outcome this system may not accept.

6. **Terraform keeps the infrastructure and the service.** VPC, subnets, ALB and target groups, ECR
   repositories, RDS, SQS/EventBridge, IAM roles, the ECS cluster, and each `aws_ecs_service` —
   including `deployment_circuit_breaker { rollback = true }`, which ADR-021 relies on and which stays
   Terraform's — are unchanged. Only `aws_ecs_task_definition` and `aws_batch_job_definition` leave its
   state, by `state rm` rather than `destroy`: a destroy would deregister the revision currently
   serving traffic.

### On reversing ADR-021's direction

ADR-021 removed CI's write because two systems wrote one field with no lock — a read-modify-write
loop across two systems, which cost three incidents. **That argument is about double writing, not
about which system writes.** This ADR keeps the single-writer property and moves the writer: after
it, CI is the only writer of a task definition, and Terraform reads none back. ADR-021's three
observed consequences are addressed rather than reintroduced:

- *An apply does not take effect.* No apply touches the template any more; there is no cutover to
  forget.
- *`terragrunt plan` can never be clean.* Strictly better — the resource leaves Terraform's state, so
  it cannot appear in a plan at all. ADR-021's gain here is preserved, not traded.
- *Tooling servicing the debt.* Unchanged; those tools are already deleted.

What ADR-021 gains that this gives back is **`image` as a constant**. The `:deployed` alias survives
and `promote-service-image` still moves it, but a CI-rendered template pins the digest again, so
ADR-021's "one writer per field" holds while its "the template is a pure function of configuration"
becomes "of configuration and the image under deploy". The honest statement is that ADR-021 solved
double-writing by removing this repository's write, and this ADR solves the same problem by removing
the other one — because the deployment-velocity cost ADR-006 predicted is now the one being paid.

## Consequences

**Easier**

- One team deploys a configuration change end to end. The critical path stops crossing an org
  boundary, which is the whole point.
- Configuration and the code reading it land in one PR, one review, one commit — `check:env` already
  enforces they agree; now they also ship together.
- `ecs:DescribeTaskDefinition` stops disclosing anything about a resident service: their
  `environment[]` is empty (126 entries move), so ADR-016's security gain is extended from 32
  variables to every variable an ECS service reads, rather than given up. The 23 Batch entries stay
  plaintext by decision 1, and disclose sandbox limits only.
- The builder's `forbidden` list gains a check. This is a net increase in trust-boundary enforcement
  over today, and the only reason a boundary-weakening change is acceptable at all.
- ADR-016's unmeasured startup-latency assumption is retired by construction.

**Harder / constrained**

- **`iam:PassRole` is the real cost.** CI gains `ecs:RegisterTaskDefinition` (which AWS does not scope
  by resource) and `iam:PassRole`. Anyone able to change a workflow file can then render a task
  definition attaching a service's task role. Mitigation is layered and none of it is optional:
  `PassRole` enumerates exactly two role ARNs and carries
  `iam:PassedToService = ecs-tasks.amazonaws.com`; `check-taskdef-boundary.mjs` asserts the rendered
  document's roles against the manifest; and the deploy workflow keeps its `environment:` gate. This
  is a genuine widening of what a repository write can reach, and it should be stated in those terms
  rather than as a configuration detail.
- **A bad configuration reaches the environment with no second team between authoring and effect.**
  The buffers are `deployment_circuit_breaker`, `deploy.yml`'s `verify-config` assertion, and
  `check-taskdef-boundary.mjs`. What is lost is a human on another team who would notice a value that
  looks wrong. Nothing here reproduces that, and the loss should not be described as fully mitigated.
- **ADR-013 becomes the primary correctness check, not a backstop.** The boot-time
  `[config-contract]` report is now the only thing proving a service received what the manifest
  declares — there is no second party's review upstream of it. `verify-config` must stay a hard gate.
- **A deploy now depends on Secrets Manager availability** at both sync and task start. Task start
  already depended on it for the 9 credentials; the new surface is the sync step, which fails loudly.
- **~$5.60/month for both environments** — 7 services × 2 environments × $0.40/secret. ADR-016 already
  ruled cost does not decide this.
- **This repository must not become a second Terraform.** The line drawn in decision 6 is the ADR-006
  split-brain hazard, and it holds only while it is respected: CI writes *configuration documents*,
  never AWS resources. A future change that has CI create a queue or a bucket is the failure this
  constraint exists to prevent, and needs its own ADR to argue for.

## Alternatives considered

- **Keep ADR-006 and shorten the handoff instead** (a DevOps-side webhook, a self-service apply).
  Rejected: it optimises the symptom while leaving two teams on one critical path, and it needs
  another team's engineering to deliver a benefit only this team receives.
- **Author Terraform in this repository, as ADR-006 sketched.** Rejected on ADR-006's own reasoning —
  two Terraform code bases with two states against one account is the split-brain that made the CDK
  drift dangerous, "only with locking behaviour to make it worse". Moving configuration out of
  Terraform's model entirely avoids the second state rather than creating it.
- **SSM Parameter Store for tiers `infrastructure` + `knob`, CI writing the parameters.** Viable and
  cheaper ($0). Rejected on one property: 149 parameters is 149 `valueFrom` entries and 149 lookups at
  task start, which is exactly ADR-016's unmeasured risk at nine times the scale. One secret per
  service is one fetch. ADR-016 called the store choice "most open to being overruled" and cheap to
  reverse; this reverses it in the direction DevOps originally proposed.
- **One secret per service holding configuration *and* credentials.** Rejected, on ADR-016's blast
  radius argument, which is untouched by anything here. See decision 2.
- **Move only tier `infrastructure`, leave 117 knobs in plaintext `environment`.** This is ADR-016's
  position and it remains defensible on its own terms — legibility and a shorter startup path. It is
  rejected here only because it does not deliver the objective: a template still carrying 117
  variables still has to be written by whoever writes the template, so the handoff survives and
  nothing is gained.

## References

- `docs/design/ci-descriptor-v3-request.md` — the 11 descriptor fields
  and the IAM this decision needs from DevOps, with the live values that evidence each shape
- [`config/env-manifest.yaml`](../../config/env-manifest.yaml) — `tier:`, `inject:`, and the new
  `value_from_output:`
- [`config/deploy/README.md`](../../config/deploy/README.md) — rewritten by this change; it currently
  describes a specification for DevOps, which this ADR ends
- `docs/design/aws-deployment.md` §6 — the environment-variable contract
- [ADR-002](ADR-002-builder-holds-no-business-credentials.md) — the boundary decision 5 must keep
  mechanically enforced
- [ADR-006](ADR-006-terraform-owns-aws-infrastructure.md) · [ADR-012](ADR-012-env-manifest-is-the-contract.md) ·
  [ADR-016](ADR-016-configuration-lives-in-three-tiers.md) — the three this partially supersedes
- [ADR-013](ADR-013-config-contract-is-observable.md) · ADR-021
