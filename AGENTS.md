# AGENTS.md

Signpost for an agent (or a human skimming fast) working in this repo. Load the row you need, not
the whole tree — every row below is under a few KB.

## Signposts

| You need to... | Read |
| --- | --- |
| Understand the system end to end | [`ARCHITECTURE.md`](ARCHITECTURE.md) |
| Find what this system promises, as built, with tests to prove it | [`docs/specs/`](docs/specs/) |
| Find a rule that must not silently break | [`docs/invariants.md`](docs/invariants.md) |
| Set up, build, run, test | [`README.md`](README.md#quick-start-from-zero), [`CONTRIBUTING.md`](CONTRIBUTING.md) |
| Know what a `pnpm run <x>` script does, and who runs it | [`eng-tools/README.md`](eng-tools/README.md) |
| Call this service from your own code | [`docs/integrator-guide.md`](docs/integrator-guide.md) |
| Submit a contract for verification | [`docs/submission-api-guide.md`](docs/submission-api-guide.md) |
| Query results across verifiers | [`docs/aggregator-query-api-guide.md`](docs/aggregator-query-api-guide.md) |
| Read a published result with no client | [`docs/reading-the-result-tree.md`](docs/reading-the-result-tree.md) |
| Stand up your own verifier | [`docs/self-hosted-deployment.md`](docs/self-hosted-deployment.md), [`docs/infrastructure-requirements.md`](docs/infrastructure-requirements.md) |
| Know what review actually checks | [`CODE_REVIEW.md`](CODE_REVIEW.md) |
| Report a vulnerability, or understand the trust model | [`SECURITY.md`](SECURITY.md) |
| Know the wire format other software depends on | [`docs/results-sep/README.md`](docs/results-sep/README.md) |

## Twelve words that mean something specific here

- **builder** — the sandboxed service that runs untrusted, submitter-supplied source. Holds no
  database access and no AWS credentials of any kind ([rule 1](docs/invariants.md)).
- **composer** — the trusted counterpart to builder: composes and caches build environments from
  official components only, holds registry-push access builder must never have.
- **orchestrator-svc** — the state machine. Dispatches builds, computes the verdict itself from
  freshly re-fetched bytes, never trusts a sandbox-reported hash on its own ([rule 2](docs/invariants.md)).
- **verifier** — an identity that publishes verification results under its own manifest. This
  repository is one verifier's deployment, not a shared platform.
- **rebuild** vs **verdict** — a rebuild attempt and whether it matches a target's currently deployed
  hash are separate entities; a job never borrows another job's verdict ([rule 15](docs/invariants.md)).
- **by-hash** — the published result index is keyed by Wasm hash alone, never by contract address or
  network ([rules 12–14](docs/invariants.md)).
- **status object** — the per-`(verifier, wasm_hash)` record; one entry, latest `verified` wins
  except a `mismatched` never displaces a `verified` ([rules 19–20](docs/invariants.md)).
- **recipe.json** / **artifact contract** — the versioned build-artifact format; a major version bump
  is required for any breaking change, and an unsupported major must fail loudly, never retry
  silently ([rules 24–25](docs/invariants.md)).
- **Results SEP** — the Stellar Ecosystem Proposal this project authors for the published contract;
  see [`docs/results-sep/`](docs/results-sep/).
- **`check:`** — a CI gate. No AWS credentials, ever. See [`eng-tools/README.md`](eng-tools/README.md)
  for the full prefix convention (`check:`/`generate:`/`deploy:`/`release:`/`e2e:`/`report:`).
- **env-manifest** — [`config/env-manifest.yaml`](config/env-manifest.yaml), the single declaration
  of every environment variable; the manifest, the code, and each service's DTO must agree
  ([rule 10](docs/invariants.md)).
- **invariant** — a rule in [`docs/invariants.md`](docs/invariants.md): something that stays true
  even after the code implementing it is rewritten. Not a design rationale, not a migration note.

## Working rules

- **This is a pnpm workspace.** Run `pnpm install`/`pnpm add` from the repo root only.
  [`CONTRIBUTING.md`](CONTRIBUTING.md) has the full workspace layout convention.
- **Before opening a PR**, run the baseline gate locally: `pnpm run build && pnpm run typecheck &&
  pnpm run lint && pnpm run test`. CI runs the same, plus the `check:` gates indexed in
  [`eng-tools/README.md`](eng-tools/README.md).
- **A rule that constrains code beyond your change belongs in `docs/invariants.md`**, as a new row —
  not in a comment, not in a new standalone document. See that file's own header for the format.
- **A comment explains what the code cannot say for itself** — a trap, an ordering requirement, a
  bound that looks arbitrary. It is never a place to restate `docs/`, cite a rule number as running
  commentary, or narrate a decision's rationale. See CONTRIBUTING.md's "Comments explain the code"
  section.
- **The pull request is the record of a change.** What you did, why, and what you rejected goes in
  the PR description, next to the diff. There is no separate per-change document to write.
- **Docs move in the same PR as the behavior they describe.** If a change makes `docs/invariants.md`,
  `ARCHITECTURE.md`, or a guide describe something untrue, update it in that PR, not a follow-up.
