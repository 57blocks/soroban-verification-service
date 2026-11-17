# Security Policy

## Scope

This service's core function is to **execute untrusted, attacker-influenced source code** (arbitrary
submitted contract sources, rebuilt by a `docker run` into a digest-pinned image) inside
`services/builder`, running as an AWS Batch job. Vulnerabilities in the sandbox boundary, the trust-policy
checks, or anything that lets untrusted source code escalate beyond that boundary are the highest-priority
class of report this project can receive.

A submitted source deciding its own Wasm is not a vulnerability. Build scripts, procedural macros and
dependencies run during the build and can make the Wasm anything, including bytes the contract's own
files do not show, and no check on the output can tell that from an honest build. A `verified` result
claims only that the complete source produces the deployed bytes
([`docs/invariants.md` rule 44](docs/invariants.md)), and that code is part of the source the result
names. A build that reaches past its own output — another job's build or result, the verifier's
credentials, a published result — is in scope.

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

- **Zero business credentials for the builder.** `services/builder` has no job role. AWS Batch runs its
  containers in the host's network namespace, so the builder hosts drop traffic to the instance metadata
  service from the job's own containers (uid 1000) and from any container on a Docker bridge. The one
  process in the job that reaches the host's instance role is the docker gateway, which runs as root and
  uses it only to authenticate a build image pull from ECR. Anything that becomes root on a host can still
  read that role, so it is scoped as if a job held it: the ECS agent's actions on the builder fleet's own
  clusters, ECR pull from the builder and composed-environments repositories, and its own CloudWatch Logs
  streams — never S3, Secrets Manager, SSM, RDS, or any business-data permission. In the reference
  deployment a permissions boundary equal to that policy keeps anything attached to the role outside
  Terraform from widening it. The builder also never imports `@scvs/db`. Artifact upload happens via a
  presigned S3 PUT URL handed to each job, not a standing grant. What an operator must provide is in
  [`clients/docs/src/self-hosting/requirements.md`](clients/docs/src/self-hosting/requirements.md).
- **Network and identity isolation of the build fleets.** The Batch build subnet is a separate VPC
  subnet and security group from the resident services and the database, so the sandbox shares no
  network boundary with the API, the console, or Postgres.

  It is also separated from the composer fleet. `services/composer` holds the one write capability in
  the system (`ecr:PutImage` on the composed-environments registry), so in the reference deployment the
  two fleets share no subnet, security group, network ACL or instance role. Each Batch subnet's network
  ACL denies all traffic to and from the rest of the VPC, the builders' allowing only the services
  subnet, independently of the security groups. Neither
  fleet's instance role can register a host into the other fleet's ECS cluster. The composed-environments
  repository is tag-immutable, and its repository policy denies push to every principal except the
  composer's job role. Reports that turn anything a build can reach into a path to that push
  capability are in scope and wanted.

  If you deploy this yourself, give the two fleets their own subnets, security groups **and instance
  roles**. The requirement is written down in
  [`clients/docs/src/self-hosting/requirements.md`](clients/docs/src/self-hosting/requirements.md).
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
  `--security-opt no-new-privileges`, `--network none` (only the dependency prefetch stage has a network,
  described below), `--read-only`, a non-root `--user` (65532, never the runner's own uid), `nosuid`
  `nodev` `noexec` tmpfs for `/tmp` and `/var/tmp`, and CPU / memory / PID limits, with a read-only
  source mount and a separate writable output mount, each a non-recursive `--mount` bind. Docker's
  default seccomp profile applies, since nothing passes `seccomp=unconfined`; no custom seccomp,
  AppArmor or SELinux profile is added. If that gap is exploitable given the above, it is worth reporting.
- **No docker socket in the runner.** The runner reaches the host's Docker daemon only through a gateway
  container in the same job, over a socket no other job can reach. The gateway forwards only what a
  sandbox stage needs: creating a container in the shape above, attaching to, waiting on, starting,
  killing and removing containers it created, and pulling an image by digest, which it authenticates
  itself when the image is in ECR. It refuses everything else, including `exec`, listing containers, host namespaces, devices, privileged
  mode, any bind that is not one of the job's workspace directories, and any network but none or the
  job's internal prefetch network. Those directories sit under a
  root-owned directory, so the runner cannot swap one for a link before a stage binds it. The daemon still
  runs as root, so a container escape through the kernel reaches the host. In the reference deployment
  that host runs no other build, before or after: each builder host takes one job and is terminated when
  it ends, by a function outside the host that nothing on it can stop.
- **Constrained dependency prefetch.** Before `cargo vendor` runs (ahead of the final no-network
  build), every `Cargo.toml` and `Cargo.lock` is parsed as TOML and each source it names is checked:
  only `https` sources pass, private, local and cloud-metadata hosts are refused, and only hosts on
  `SCVS_PREFETCH_ALLOWED_HOSTS` pass. A file that cannot be read or parsed fails the job. The network
  enforces the same list: the prefetch container sits on an internal Docker network with no route off
  the host, and its only way out is an egress proxy the docker gateway runs for the job. The proxy opens
  a tunnel only to port 443 of a host on the list, resolves the name itself, refuses it if any address
  it resolves to is not public, and connects to the address it checked. The builder hosts also drop
  traffic from any Docker bridge to a non-public address or to the host itself. Whatever the submitted
  source or its dependency graph names, nothing else is reachable from the prefetch stage.
- **Integrity checks on submitted source.** Both source shapes a submission can take — a private
  upload and a `source_uri` archive — are verified against the caller-provided SHA-256 before use, and
  the build job's materialise container hashes the bytes it downloads again before it unpacks them. A `source_uri` job proves it holds
  those bytes by fetching its own URL before it may share a rebuild another submission started.
- **Abuse controls on the public API.** `services/verification-svc` combines an in-process rate limiter
  (`@nestjs/throttler`) with a DB-backed `AbuseGuard` for stronger enforcement, and gives its public read
  routes and API documentation a per-caller quota of their own. `services/query-svc`
  carries a per-caller in-process quota on every read route, and a tighter one on the single route that
  resolves a contract address, since each such request costs an outbound Soroban RPC call. Both services
  key their counters on the forwarded caller address, not the balancer's.

If you find a way around any of the above — or a gap these don't cover — that's exactly what this policy
wants reported.
