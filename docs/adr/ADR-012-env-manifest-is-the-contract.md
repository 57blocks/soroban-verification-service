# ADR-012: One manifest declares the environment contract; the repo owns its shape, DevOps owns its values

> **Status**: Accepted 2026-08-12 (teki) · promoted from `Proposed` under the standing ruling that a `Proposed` status on shipped scope is a status nobody wrote back, and the state of the code decides it
> **Scope**: `config/env-manifest.yaml`, every `src/config/env.dto.ts`, `docs/design/aws-deployment.md` §6,
> `.env.example` and `services/*/.env.example`, `eng-tools/check-env-manifest.mjs`, CI
> **Depends on**: [ADR-004](ADR-004-class-validator-as-single-source.md) (boot validation),
> [ADR-006](ADR-006-terraform-owns-aws-infrastructure.md) (who owns AWS),
> [ADR-002](ADR-002-builder-holds-no-business-credentials.md) (the asymmetry this makes checkable)
>
> ★ **Amended 2026-09-04 — `decided: Q2` partially superseded by
> [ADR-025](ADR-025-deployment-configuration-is-owned-by-this-repository.md)** (Proposed). The manifest
> remains the contract and this ADR's decisions stand. What changes is one clause of `decided: Q2`:
> an identifier carrying an account id, region, or revision still carries **no committed value** — that
> prohibition is unchanged, and for the reason recorded here — but it now carries
> `value_from_output:`, a path into `/scvs/<env>/ci/descriptor` that CI resolves at deploy time from
> Terraform's own outputs. The title's "DevOps owns its values" therefore narrows to the 9 credentials
> in Secrets Manager; the rest are owned here or resolved fresh from the descriptor. Nothing that can
> go stale becomes committed, which is what `decided: Q2` existed to prevent.

## Context

Handing the environment contract to DevOps exposed that we did not have one. We had three
descriptions of it, none complete, and they had already drifted:

| Where | For whom | State on 2026-08-04 |
| --- | --- | --- |
| `services/*/src/config/env.dto.ts` | the process, at boot | **12 live variables unvalidated** |
| `docs/design/aws-deployment.md` §6 | DevOps | prose tables; nothing compares them to anything |
| `.env.example`, `services/orchestrator-svc/.env.example` | local development | **declared a variable no code reads** |

The drift was not cosmetic in either direction.

**Under-declared.** `SCVS_R2_REGION` is required in `dev` because its default is the literal string
`auto`, which real AWS S3 rejects — and no DTO mentioned it. `SCVS_PUBLISHER_PREFIX` defaults to `""`,
so an unset value writes our result tree into the root of a bucket DevOps also uses; also absent.
`SCVS_VERIFIER_ID` defaults to `local-verifier`, and every artifact published without it is stamped
and indexed under that name — immutably, since the artifact is already written and possibly already
aggregated by another verifier. Also absent. Nine more like them.

**Over-declared.** `services/orchestrator-svc/.env.example` set `SCVS_BUILD_DISPATCH=batch` with a
comment describing the "in-process fallback" it opted out of. [ADR-003](ADR-003-always-dispatch-builds-to-aws-batch.md)
deleted that path; no code has read the variable since. It read as if a local-only mode existed.

This is the same failure that killed `infra/cdk/` (ADR-006): a description of the system that nothing
compares to the system. ADR-006 named the mitigation and its weakness in the same breath — "a prose
contract has the same weakness … the mitigation is that the contract records the `aws` CLI commands
that verify each claim, and the runbook makes running them a step — not that drift is now impossible."
For infrastructure that is as far as we can go, because the resources are not ours. For **environment
variables it is not**: both sides of that contract are files in this repository, so the comparison can
be a CI job rather than a runbook step someone remembers.

There is a second thing a prose table cannot do. [ADR-002](ADR-002-builder-holds-no-business-credentials.md)
says the builder holds no business credentials, and `BuilderEnvDto` enforces it by *omission* — it
deliberately does not extend `SharedEnvDto`, so the Postgres and result-storage variables are not
listed. Omission is invisible: nothing distinguishes "deliberately absent" from "forgotten", and
nothing at all stops the sandbox's source from growing a `process.env.POSTGRES_PASSWORD` read.

## Decision

**`config/env-manifest.yaml` is the single declaration of the environment contract. This repository is
authoritative for its shape; DevOps is authoritative for its values. `eng-tools/check-env-manifest.mjs`
fails CI when the manifest, the code, and the boot-validation DTOs disagree.**

1. **One file declares every variable**, with: type, required-ness, failure mode, default, secret-ness,
   which service reads it, where its value comes from, and the reader that owns its default. A
   variable added to code is added to the manifest and to the service's `env.dto.ts` in the same PR.

2. **The shape/value split follows ADR-006.** `source:` states who supplies each value — `literal`
   (repo-owned), `terraform` (a DevOps output), `secret` (a Secrets Manager reference), `image-build`,
   or `per-invocation`. For anything that is not `literal`, an `envs:` value in the manifest is a
   **record for cross-checking, not the source of truth**; if Terraform disagrees, Terraform is right
   and the manifest is a bug. No secret value ever appears in the file — only a reference.

3. **`fail:` classifies what a missing value costs**, because that is what DevOps actually needs and
   what prose buried: `boot` (the process refuses to start), `first-use` (boots healthy, fails the
   first request that needs it), `silent` (wrong or absent, no error, degraded behaviour), `n/a`.
   The `silent` class is the reason a green health check does not mean a service is configured — a
   missing `SCVS_JOB_STATE_CHANGE_QUEUE_URL` yields a service that queues and dispatches normally and
   completes nothing, with no failing check and no log line.

4. **`required: forbidden` is a checked assertion, not a comment.** The builder's block names every
   variable that must never reach it, and CI fails if that service's source reads one, or if
   `docker/builder.Dockerfile` sets one. This is ADR-002 becoming mechanical. Its limit is stated in
   the checker: the Batch job definition is Terraform's, so a forbidden variable *injected* by
   infrastructure is invisible here — what this catches is our own code growing a read for one.

5. **`docs/design/aws-deployment.md` §6 keeps the reasoning and stops repeating the facts.** It points
   at the manifest for every per-variable detail. It remains the contract document ADR-006 decision 2
   names; the manifest is the machine-readable half of it, not a replacement.

6. **`groups` express requirements, not convenience.** A group exists where two services sharing a
   variable is a correctness requirement — `result-storage` carries
   `invariant: identical-across(orchestrator-svc, query-svc)`, because the writer and the reader
   looking at different places is, per §6.4, the single most likely misconfiguration in this
   deployment and nothing detects it at runtime.

7. **The manifest is not generated from code, and does not generate code.** The DTOs stay
   hand-written: ADR-004's value is in the per-variable failure messages, which explain *why* a value
   is rejected, and a generator would flatten them. The manifest and the DTOs are two independent
   statements that CI forces to agree — which is what makes their agreement mean something.

## Consequences

**Easier**

- One place to look, and one place to change. The DevOps hand-off is a file diff.
- The twelve gaps above are closed, and cannot silently reopen: adding a `process.env` read without
  declaring it fails CI.
- ADR-002 gains a test. Before this, "the sandbox has no database access" was enforced by a DTO not
  listing something — true, and invisible to a reviewer who did not already know it was load-bearing.
- Retired variables get deleted instead of preserved out of caution, because the manifest has a
  `retired:` block that says so and CI enforces their absence from `.env.example` files and images.

**Harder / constrained**

- **A fourth place to update.** Adding a variable now touches code, the DTO, and the manifest. The
  checker makes forgetting loud rather than harmless, which is the point, but the cost is real and
  falls on every PR that adds a knob.
- **The manifest can be accurate and still wrong.** It records some values it does not own, so it is
  a second copy and nothing outside a human comparing it to `terraform output` catches divergence.
  Narrowed by manifest `decided: Q2`: a stable resource *name* is recorded, because ADR-006's own
  consequences ask for renames to be greppable; an identifier embedding an account id, region, or
  revision is not, because it goes stale and then misleads — the builder job-definition ARN changes
  on every deploy. This is ADR-006's "drift will come back", reduced rather than eliminated.
- **`fail: silent` is classified, not prevented.** The manifest tells you which variables fail
  invisibly; it cannot make them fail loudly. Detection was since decided to be ours rather than
  DevOps's — an internal diagnostic endpoint asserted by CI after deploy, manifest `decided: Q4` —
  but that is follow-up work with its own unresolved design decision (what may be reported), and
  probably its own ADR. Until it exists, this ADR's contribution to the `silent` class is a label.
- **DTO inheritance is coarser than the manifest's groups.** TypeScript has single inheritance, so
  `SharedEnvDto` covers `base` + `postgres` + `stellar-cli` in one class and query-svc validates two
  variables it never reads. `dto_over_declares` names them per service rather than weakening the
  check globally — an escape hatch that will need pruning if it grows.
- **The checker is regex over source, not the TypeScript compiler.** It understands the declaration
  style these files actually use. A computed or spread DTO field would be reported as extra rather
  than understood — chosen deliberately over making a hygiene check depend on the compiler API, and
  the failure direction is safe.

## Alternatives considered

- **Generate the DTOs from the manifest.** Rejected per decision 7: it makes the two statements one,
  so their agreement stops being evidence, and it destroys the hand-written failure messages that are
  ADR-004's actual value. The gap it would close — a DTO drifting from the manifest — is closed by
  check C/D instead, at no cost to the messages.
- **Generate the manifest from the code.** Rejected: the fields that matter most to DevOps — `fail:`,
  `source:`, `inject:`, `secret_ref:`, `required: forbidden` — are not derivable from a
  `process.env.X` read. A generated manifest would contain exactly the half nobody needed a manifest for.
- **Keep the prose tables and add a linter over them.** Rejected: parsing Markdown tables to check a
  contract is strictly worse than reading YAML, and the tables would still have to carry the
  reasoning, so nothing would be simplified.
- **Environment-specific manifests (`env.dev.yaml`, `env.prod.yaml`).** Rejected for now: with one
  real environment it would triplicate the shape to vary the values, and the shape is the part this
  repo owns. If `envs:` blocks get unwieldy at three environments, split values out and keep one
  shape file — a cheap reversal, since the shape is already separate from the values. Note this is
  *not* what manifest `decided: Q1` adds: the generated per-environment artifacts are outputs of the
  one shape file, not additional hand-maintained sources.
- **Let Terraform resolve `groups`/`inherits` itself, reading this file directly.** Rejected in
  manifest `decided: Q1`: the composition rules are this repo's semantics, and reimplementing them in
  HCL would give one contract two implementations while `check:env` covers only ours. A mistake on
  that side puts wrong values in a deployed task definition with nothing failing anywhere.
- **Let DevOps own the manifest in the Terraform repo.** Rejected: the shape is derived from this
  code, changes with this code, and must be reviewable in the PR that changes it. Owning it there
  re-creates the ADR-006 split-brain with the direction reversed.

## Amendment 2026-08-13 — decision 4's stated limit was too narrow, and the gap was real

Decision 4 says `required: forbidden` is checked, and states its limit honestly: "the Batch job
definition is Terraform's, so a forbidden variable *injected* by infrastructure is invisible here —
what this catches is our own code growing a read for one." That describes check E exactly. What it
missed is that E only ever compares a `forbidden:` list against *code*, so **nothing looked at the list
itself**, and a list can stop denying a capability without any code changing.

It did: the composer's list named `SCVS_BATCH_JOB_QUEUE_ARN` — in this manifest's own `retired:`
block since the queue-per-architecture split — and named none of the three variables that replaced it,
under a header comment reading "Everything the builder is forbidden, for the same reasons". `check:env`
exited 0 throughout, correctly by its own terms: the composer reads none of those variables. The
declaration was broken, not the code, and the generated `config/deploy/dev/composer.json` DevOps
consumes carried the defect outward.

Two checks close it, and the limit above still stands for everything else:

- **F** now also fails on a `forbidden:` entry naming a `retired:` variable.
- **K** enforces `forbidden_superset_of: <service>`, a service-level manifest key that replaces the
  header comment. Superset and not equality: the composer forbids two variables the builder legitimately
  reads, so the lists can never be identical.

The general rule this adds to decision 4: **a relationship between two parts of the manifest is declared
in the manifest and checked, or it is not claimed.** A comment asserting an invariant nothing enforces is
how this happened, and it is the same failure shape check G was already written for. Recorded at
`docs/features/build-environments/decisions/a-forbidden-list-relationship-is-declared-and-checked.md`,
which also corrects the earlier account of the cause: the composer's list was not left behind by the
rename, it was **born wrong** two hours after the rename had already landed and updated the builder's.

## References

- [`config/env-manifest.yaml`](../../config/env-manifest.yaml) — the manifest, its `decided:` block
  (Q1 flat generated artifacts, Q2 which values are recorded, Q4 silent-variable detection, Q5 the
  SQS queue, Q3 the secret-injection shape — all five closed as of 2026-08-04)
- [`eng-tools/check-env-manifest.mjs`](../../eng-tools/check-env-manifest.mjs) — the checks A–K, and
  what each one cannot see. The header comment enumerates them; it is deliberately not counted here,
  because the count in this line said "seven" for as long as there were eleven
- `docs/design/aws-deployment.md` — §6,
  the reasoning the manifest deliberately does not carry
- [ADR-002](ADR-002-builder-holds-no-business-credentials.md) — the asymmetry `required: forbidden` checks
- [ADR-004](ADR-004-class-validator-as-single-source.md) — why the DTOs stay hand-written
- [ADR-006](ADR-006-terraform-owns-aws-infrastructure.md) — the shape/value ownership split, and the
  drift failure this ADR narrows
