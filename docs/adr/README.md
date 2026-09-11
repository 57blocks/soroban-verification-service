# Architecture Decision Records

Repo-level decisions — the ones that cut across services and that a future change is likely to
trip over. Feature-scoped decisions live in `docs/features/<feature>/decisions/` instead; promote
one here when it turns out to be cross-cutting, and leave a pointer behind.

## Index

| ID | Title | Status |
| --- | --- | --- |
| [ADR-002](ADR-002-builder-holds-no-business-credentials.md) | The builder holds no business credentials | Accepted (recorded 2026-07-27) |
| [ADR-003](ADR-003-always-dispatch-builds-to-aws-batch.md) | Always dispatch builds to AWS Batch; no in-process fallback | Accepted (recorded 2026-07-27) |
| [ADR-004](ADR-004-class-validator-as-single-source.md) | One `class-validator` class is the validation rule, the type, and the OpenAPI schema | Accepted (recorded 2026-07-27, supersedes the original Zod approach; revised 2026-08-06: the schema is derived from the validation, not declared) |
| [ADR-005](ADR-005-dto-ownership-follows-use.md) | DTO ownership follows use; `packages/schema` retired | Accepted 2026-07-27 (revised 2026-08-06: core no longer carries `@nestjs/swagger`, so nothing inherits it) |
| [ADR-006](ADR-006-terraform-owns-aws-infrastructure.md) | Terraform owns AWS infrastructure; this repo ships images and a contract | Accepted 2026-07-29 |
| [ADR-007](ADR-007-by-hash-index-is-network-independent.md) | The by-hash result index and its query surface are network-independent | Accepted 2026-07-30 |
| [ADR-008](ADR-008-rebuild-and-verdict-are-separate-entities.md) | A rebuild attempt and a target's verdict are separate entities | Proposed 2026-07-30 |
| [ADR-009](ADR-009-build-environments-are-composed-from-official-components.md) | Build environments are composed from official components | Accepted 2026-07-30 (revised 2026-08-05: the resolution mechanism is not part of the decision) |
| [ADR-010](ADR-010-result-root-holds-only-hash-keyed-documents.md) | The published result root holds only hash-keyed documents | Accepted (recorded 2026-07-30) |
| [ADR-012](ADR-012-env-manifest-is-the-contract.md) | One manifest declares the environment contract; the repo owns its shape, DevOps owns its values | Proposed 2026-08-04 |
| [ADR-013](ADR-013-config-contract-is-observable.md) | A service reports its own configuration contract; the manifest decides what it may reveal | Proposed 2026-08-04 |
| [ADR-014](ADR-014-status-object-holds-the-latest-verified-only.md) | The status object holds one entry per verifier, latest `verified` wins, and carries no extension | Accepted 2026-08-12 (this index said Proposed until 2026-09-02; the file's header was right). **Reaffirmed by ADR-024** 2026-09-02: all four decisions stand, 1 and 2 under new reasoning |
| [ADR-015](ADR-015-test-suites-own-the-rows-they-create.md) | Test suites own the rows they create, and the shared Postgres is not reset between them | Proposed 2026-08-06 |
| [ADR-016](ADR-016-configuration-lives-in-three-tiers.md) | Configuration lives in three tiers, and sensitivity decides which | Proposed 2026-08-06 |
| [ADR-017](ADR-017-compose-once-cache-in-private-registry.md) | Compose a build environment once per `(cliver, rsver, template_version)`, cache it by digest in a private ECR repository, publish the full recipe regardless | Accepted 2026-08-05 (one dependency open: `infra-and-ops`'s CE1/CE4 mechanism, which it extends rather than decides) |
| ADR-020 | Batch jobs are dispatched by job definition family name, not by revision ARN | Accepted 2026-08-22 (reverses a decision recorded in config/env-manifest.yaml; applied to dev and staging first, ratified after) |
| ADR-021 | A service image is delivered by a mutable alias tag, and the service pointer belongs to Terraform | **Proposed** 2026-08-26 (awaiting signature) |
| [ADR-022](ADR-022-artifact-contract-is-versioned-and-orchestrator-deploys-first.md) | The build-artifact contract is versioned, and the orchestrator deploys before the builder | **Proposed** 2026-09-01 (awaiting signature) |
| [ADR-023](ADR-023-the-project-is-licensed-apache-2.md) | The project is licensed Apache-2.0, collapsing the TRD's "Apache-2.0 or MIT" to one answer | **Proposed** 2026-09-02 (awaiting signature) |
| [ADR-024](ADR-024-published-contract-is-the-results-sep-we-author.md) | The published contract is the Results SEP we author — verifier-keyed entries, two custody fields, structured links, declared document identity | **Proposed** 2026-09-02 (records TRD decision D9; reaffirms ADR-014). Amended 2026-09-03 (signing withdrawn), 2026-09-04 (`location` axis), 2026-09-10 (**the SEP ships as two**, verifier read surface first) |
| [ADR-025](ADR-025-deployment-configuration-is-owned-by-this-repository.md) | Deployment configuration is owned by this repository and delivered through Secrets Manager | Accepted 2026-09-04 (partially supersedes ADR-006, ADR-012, ADR-016; reverses ADR-021's writer direction; ratifies the contract side as applied — the deploy side is not built) |
| ADR-026 | The git ref is the version and the release channel — `main` mints a `dev` prerelease, a tag mints `staging`/`stable`, and `latest` may never hold a prerelease | **Proposed** 2026-09-04 (fills a gap — no ADR ever stated a release policy) |
| [ADR-027](ADR-027-the-pull-request-is-the-record.md) | The pull request is the record of a change; the per-feature document set retires | Accepted 2026-09-10 (replaces the per-feature requirements record that preceded it) |

ADR-001…008 were reviewed against TRD 2.0 on 2026-07-31 and stand, with **one recorded tension**:
ADR-003 hard-codes AWS Batch dispatch with no conditional branch, while TRD §4.6 requires batch
compute behind adapters with no hard single-cloud dependency — reconciliation belongs to the
deployment-modes design and is tracked in the conformance table, not resolved by this note.
ADR-008's model has since landed (the job-dedup fixes, PRs #13/#14: rebuild entity, per-tick job
resolution); its status line awaits the flip to Accepted by its author.

"Recorded" means the decision was already in force in the codebase and is written down here after
the fact. The reasoning is reconstructed from the code and its comments, not invented — each ADR
cites where the constraint is actually enforced.

## Conventions

- Filenames are `ADR-###-<kebab-title>.md`, zero-padded. **Numbers are never reused or renumbered.**
- Status is one of `Proposed | Accepted | Superseded`.
- A superseded ADR keeps its file and gains a forward pointer (`Superseded by ADR-0NN`). Deleting it
  would destroy the reasoning, which is the only reason the file exists.
- Amend an accepted ADR in place for clarifications, and note the revision in the status line of
  this index — e.g. `Accepted (revised 2026-08-01: X removed)`. Reverse the decision by writing a
  new ADR that supersedes it, not by rewriting history.
- One decision per file.

## When you need one

Write an ADR before changing anything that: crosses a service boundary, changes the IAM/trust
model, changes the published artifact or HTTP wire format, adds a second way to do something the
repo already does one way (a second validation library, a second HTTP client), or removes a
constraint another component silently relies on.

If you are about to do one of those and no ADR covers it, that is the signal to write one — not to
proceed and document later.
