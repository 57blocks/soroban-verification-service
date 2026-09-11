# Security Policy

## Scope

This service's core function is to **execute untrusted, attacker-influenced source code** (arbitrary
submitted contract sources, rebuilt by a `docker run` into a digest-pinned image) inside
`services/builder`, running as an AWS Batch job. Vulnerabilities in the sandbox boundary, the trust-policy
checks, or anything that lets untrusted source code escalate beyond that boundary are the highest-priority
class of report this project can receive.

There is one rebuild path. `stellar contract verify` was a second one until it was retired, after
upstream closed the subcommand as won't-ship; nothing in this repository invokes it.

## Reporting a vulnerability

**Do not open a public GitHub issue for a security vulnerability.**

Report it privately through GitHub's security advisory feature: this repository's **Security** tab →
**Report a vulnerability**. If that option isn't available, email opensource@57blocks.com instead of
filing a public issue.

### What you can expect

| | |
| :--- | :--- |
| Acknowledgement | within **3 working days** |
| An initial assessment — in scope or not, and a severity | within **10 working days** |
| Progress updates | at least every **14 days** while the report is open |
| Credit | in the advisory, under whatever name you give us, unless you ask us not to |

If a deadline passes without a word from us, that is our failure and not a reason for you to stay
quiet: say so in the thread, and escalate to opensource@57blocks.com.

### Safe harbour

We will not pursue or support legal action against anyone who reports a vulnerability in good faith
under this policy. Good faith means: you tested against **your own deployment or the sandbox's own
build path**, you did not access, modify, or destroy data belonging to anyone else, you did not
degrade the service for other users, and you gave us a reasonable chance to fix the issue before
disclosing it.

This project invites people to run untrusted code inside its sandbox — that is what the sandbox is
for. Doing so, and telling us what you found, is not something we will treat as an attack.

Two things this cannot cover, because they are not ours to give: the safe harbour does not extend to
third-party services this deployment depends on, and it is not a waiver of anyone else's rights.

### How a fix gets made

Development happens in the open, so there is no private branch to fix a vulnerability on. Instead we
open a **draft security advisory** and work in the temporary private fork GitHub attaches to it. The
fix, the advisory, and the release come out together. That is why a report must not arrive as a pull
request: a pull request is a public disclosure of the bug it fixes.

Please include:
- A description of the vulnerability and its impact.
- Steps to reproduce (a minimal submitted contract/source that triggers it, if applicable).
- Which component is affected (`services/builder`'s sandbox, `services/composer`'s image composition,
  `services/orchestrator-svc`'s policy checks, the public HTTP surface, IAM/infra, etc.).

## Existing security boundaries

So a report can focus on what's actually new, here's what's already enforced (see the referenced source
for exact mechanics — this list is not exhaustive):

- **Zero business credentials for the builder.** `services/builder`'s AWS Batch instance/execution IAM
  roles are scoped to ECR pull + CloudWatch Logs only — never S3, Secrets Manager, RDS, or any
  business-data permission. It also never imports `@scvs/db`. Artifact upload happens via a presigned
  S3 PUT URL handed to each job, not a standing grant. What an operator must provide is in
  [`docs/infrastructure-requirements.md`](docs/infrastructure-requirements.md).
- **Network isolation, and one gap we are not going to imply away.** The Batch build subnet is a
  separate VPC subnet and security group from the resident services and the database, so the sandbox
  shares no network boundary with the API, the console, or Postgres.

  It is **not** separated from the composer fleet. `services/composer` holds the one write capability
  in the system (`ecr:PutImage` on the composed-environments registry), and in the reference
  deployment both fleets run in the builders' subnet behind the builders' security group. The target
  architecture puts them in separate groups; that is a requirement we state and have not yet met, and
  an escape from the sandbox therefore starts on the same network segment as a registry-push
  credential. Reports that turn network adjacency into a capability are in scope and wanted.

  If you deploy this yourself, give the two fleets their own subnets and security groups — the
  requirement is written down in [`docs/infrastructure-requirements.md`](docs/infrastructure-requirements.md),
  and unlike us you can meet it from the start.
- **The build image is never chosen by the submitter.** It is derived from the deployed Wasm's own
  metadata, and a `bldimg` in a submitted manifest is compatibility-only for older clients — never
  consulted (`resolveEnvironmentIdentity`, `services/orchestrator-svc`). Two classes reach the sandbox:
  - **Chain-named (cli-58).** `evaluateBuildImage` accepts only
    `docker.io/stellar/stellar-cli@sha256:...` — never a mutable tag, never an arbitrary image.
  - **Composed (cli-legacy).** Where the chain records no image, the verifier builds one from the
    recorded `(cliver, rsver)` pair and pushes it to its own private registry, so it does not pass the
    check above. Its trust comes from what goes into it: a digest-pinned Docker Official base, a
    checksum-pinned rustup installer, and a stellar-cli release asset verified against the digest
    GitHub publishes ([`docs/invariants.md` rules 16–18](docs/invariants.md)).
- **The two Batch jobs hold opposite capabilities, deliberately.** Composition runs in
  `services/composer`, whose trust boundary is the inverse of the builder's: the builder *runs*
  untrusted code and therefore holds nothing, while the composer runs no untrusted code but holds the
  one write capability (`ecr:PutImage`) the builder must never have. Neither reaches Postgres or the
  result storage — `config/env-manifest.yaml` lists those variables as `forbidden` for both groups, so
  `pnpm run check:env` fails on either direction of drift rather than leaving it to review
  ([`docs/invariants.md` rule 10](docs/invariants.md)).
  Both are container-execution-capable and both are therefore under CE1–CE5, for opposite reasons.
- **Sandboxed rebuilds.** The `docker run` rebuild — the only rebuild path — uses `--cap-drop ALL`,
  `--security-opt no-new-privileges`, `--network none`, `--read-only`, a non-root `--user`, `nosuid`
  `nodev` `noexec` tmpfs for `/tmp` and `/var/tmp`, and CPU / memory / PID limits, with a read-only
  source mount and a separate writable output mount. No seccomp or AppArmor profile is applied; if
  that gap is exploitable given the above, it is worth reporting.
- **Constrained dependency prefetch.** `cargo vendor` dependency prefetching (run before the final
  no-network build) rejects URLs targeting private, local, or cloud-metadata hosts; only an explicit
  allowlist (`SCVS_PREFETCH_ALLOWED_HOSTS`) of public dependency hosts is reachable.
- **Integrity checks on submitted source.** Both source shapes a submission can take — a private
  upload and a `source_uri` archive — are verified against the caller-provided SHA-256 before use, and
  re-hashed inside the sandbox against the bytes actually fetched.
- **Abuse controls on the public API.** `services/verification-svc` combines an in-process rate limiter
  (`@nestjs/throttler`) with a DB-backed `AbuseGuard` for stronger enforcement.

If you find a way around any of the above — or a gap these don't cover — that's exactly what this policy
wants reported.
