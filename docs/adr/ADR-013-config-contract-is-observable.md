# ADR-013: A service reports its own configuration contract, and the manifest decides what it may reveal

> **Status**: Accepted 2026-08-12 (teki) · promoted from `Proposed` under the standing ruling that a `Proposed` status on shipped scope is a status nobody wrote back, and the state of the code decides it
> **Scope**: `config/env-manifest.yaml`'s `observable:` field, `packages/config/src/config-contract.ts`
> and its generated descriptor, `services/{verification,orchestrator,query}-svc`'s
> `modules/config-contract/`, `eng-tools/{env-manifest,generate-env-contract}.mjs`, checks H and I
> **Depends on**: [ADR-012](ADR-012-env-manifest-is-the-contract.md) (the manifest, and its
> `decided: Q4`), [ADR-002](ADR-002-builder-holds-no-business-credentials.md) (why the sandbox has none)

## Context

ADR-012 gave the environment contract a `fail:` field, and with it a category the repository had never
named: **`fail: silent`** — a variable whose wrong or absent value leaves a perfectly healthy service
doing the wrong thing. That ADR was explicit that it only *labels* the category:

> `fail: silent` is classified, not prevented. The manifest tells you which variables fail invisibly; it
> cannot make them fail loudly.

The reference case is `SCVS_JOB_STATE_CHANGE_QUEUE_URL`. Unset, orchestrator-svc polls for queued jobs,
dispatches them to AWS Batch, the builds succeed — and no result is ever consumed. Every job sits
non-terminal forever. Nothing fails: the container is healthy, the ALB has no opinion (there is no ALB),
and no log line fires because nothing went wrong. Boot validation (ADR-004) cannot help either, because
the variable is optional and its absence is not malformed.

Three mechanisms were available and two are worse:

- **A metric alarm** on "verifications completed". In an environment with legitimately zero traffic —
  which `dev` is, most of the time — the signal-to-noise is hopeless.
- **A post-deploy smoke test** that submits a contract and waits for a terminal state. It works, and it
  costs a real AWS Batch build (minutes, plus compute) on every deploy to learn something a
  configuration read answers in milliseconds.

## Decision

**Each resident service reports which of its declared variables are actually set, and
`config/env-manifest.yaml` decides what that report may reveal.**

1. **`observable:` per variable, defaulting to `presence`.** `presence` reports a boolean; `value`
   reports the value itself. Nothing else.

2. **Two rules `check:env` enforces (check H), both failing closed.** A `secret: true` entry must be
   `presence` — no value, and **no hash of one**, because a password digest is a cracking target rather
   than a redaction. And `observable: value` requires the entry to declare `values:`, so a free-text
   value cannot become reportable without someone inventing an enum for it in review. A bucket name has
   no `values:` list; that is the point.

3. **The boundary is data, not code.** It lives in the manifest specifically so that widening it appears
   in a diff of the contract file, reviewed as a contract change. A boundary expressed as a redaction
   list inside a service would be invisible in exactly the review that should catch it.

4. **A group carrying `invariant: identical-across(...)` also gets a digest** over its non-secret
   members, so two services' shared configuration can be compared without either revealing it. Derived
   from the invariant rather than declared separately, so the two cannot disagree. Today that is
   `result-storage`, whose mismatch is — per the deployment contract §6.4 — the single most likely
   misconfiguration in the deployment, with nothing detecting it at runtime.

5. **Reported two ways, for two different questions.** An internal HTTP route answers "what is this
   service configured with *now*", which an operator asks mid-incident. A structured line at boot is
   what CI asserts after a deploy — and it is the only one that works for orchestrator-svc, which has no
   ALB and no service discovery, and which owns the reference `fail: silent` variable. Neither may fail
   a boot; a diagnostic that can prevent startup has inverted its purpose.

6. **The sandbox never has one.** `services/builder` gets no endpoint, no boot report, and no
   descriptor. Check I fails if its manifest block ever declares `config_contract: true`. It has no HTTP
   listener and, by ADR-002, no configuration worth reporting.

7. **Services consume a generated descriptor, not the manifest.** `eng-tools/env-manifest.mjs` resolves
   the manifest's composition exactly once and `generate-env-contract.mjs` emits a committed TypeScript
   descriptor. Reasoning in
   `../features/config-contract-endpoint/decisions/resolver-lives-in-eng-tools.md`;
   check I fails when the committed file and the manifest disagree.

## Consequences

**Easier**

- The `fail: silent` class becomes checkable after a deploy, in milliseconds, without a build.
- §6.4's writer/reader invariant gets a runtime test for the first time. It was previously enforced by
  a sentence in a document.
- Widening what is reportable is a manifest diff, not a code change nobody reads.

**Harder / constrained**

- **The digest is a comparison primitive, not a confidentiality one.** `sha256` over a low-entropy input
  like a bucket name is brute-forceable by anyone who can guess candidates. This is acceptable **only**
  because the route is not publicly routable and anyone who can reach it can already read the task
  definition — not because the hash hides anything. Stated here rather than implied, because a future
  reader could otherwise treat a digest as a redaction and expose one somewhere it is not.
- **`internal/` is a signal, not enforcement.** Nothing on the ALB routes to it, and that absence is
  Terraform's — so it is stated in the deployment contract and *not* guaranteed by this repository. A
  listener rule added later would expose these routes on two public services.
- **Another generated artifact in review diffs**, and a fifth thing to regenerate. Mitigated by check I
  and `pnpm run generate:env-contract`, but the cost is real.
- **Presence means non-empty, not defined.** `SCVS_PUBLISHER_PREFIX=""` reports `false`, because that is
  how every consumer treats it (`||`, `requireEnv`). The digest keeps the exact distinction; the boolean
  reports effective configuration. Two fields, two different questions, and the asymmetry will surprise
  someone.
- **The assertion covers presence far better than correctness.** `eng-tools/assert-config-contract.mjs`
  runs in `deploy.yml` after the services go stable, and it can only compare a value the manifest
  actually records — which, per `decided: Q2`, excludes every identifier carrying an account id, region,
  or revision. So `SCVS_JOB_STATE_CHANGE_QUEUE_URL` being *absent* is caught, and its being subtly wrong
  is not. That happens to match the failure mode (absence is the outage), but it is a real ceiling, and
  the assertion prints the list of variables it could only check for presence rather than implying more.

## Alternatives considered

- **Post-deploy smoke test instead.** Rejected as the primary mechanism: a real Batch build per deploy
  to learn what a config read answers immediately. Still the right tool for `fail: first-use` variables
  like verification-svc's `SCVS_STORAGE_BUCKET`, which no config read can validate — the deployment
  contract §6.2 already asks for one there.
- **Return HTTP 503 when a `fail: silent` variable is unset**, so the condition fails closed. Rejected:
  it would pull a service that is genuinely serving traffic out of its target group over a variable
  affecting a different code path. Report; let CI decide.
- **A redaction allowlist in each service instead of `observable:` in the manifest.** Rejected per
  decision 3 — it puts a security boundary where a review will not look at it, and triplicates it.
- **Report every variable in `process.env`.** Rejected: the report must describe the *declared* contract.
  An undeclared variable appearing in it would hide precisely what check A exists to catch.
- **Read the manifest at runtime.** It is genuinely available in the image. Rejected in the feature's
  decision record: it adds a YAML parser to a package three services import, and moving the resolver
  into `@scvs/config` would cost `check:env` the build-free property that lets CI run it before Build.

## References

- `docs/features/config-contract-endpoint/plan.md` — the
  implementation, its phases, and phase 6's blocker
- [`config/env-manifest.yaml`](../../config/env-manifest.yaml) — `observable:`, and `decided: Q4`
- `docs/design/aws-deployment.md` — §6, and
  §6.4's invariant this makes testable
