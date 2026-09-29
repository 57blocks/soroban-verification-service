# Contributing

Thanks for contributing to the Soroban Contract Verification Service.

## Getting set up

Follow the README's [Quick Start From Zero](README.md#quick-start-from-zero) — prerequisites, workspace
install order, local Postgres, and how to run each service. For the architecture and full command
reference, see [ARCHITECTURE.md](ARCHITECTURE.md).

## Workspace conventions

- This is a **pnpm workspace**. Always run `pnpm install`/`pnpm add` from the repo root, not inside a
  package directory, and never mix in `npm`/`yarn`.
- `packages/*` and the generated API client compile to `dist/`/`generated/` (gitignored). After changing
  anything under `packages/*`, rebuild it (`pnpm --filter @scvs/<name> run build`) before the services or
  tests that depend on it will pick up the change.
- Each service's `src/` follows the same shape: `modules/<feature>/` per feature, `common/` for
  cross-module code within that service, `config/configuration.ts` as the single `ConfigService` loader.
  New code should follow this layout rather than adding loose files at `src/` root — see ARCHITECTURE.md's
  "Per-service internal structure" section for the reasoning.

### Comments explain the code, and nothing else

**The default is no comment.** Write one only for what the code cannot say for itself: a non-obvious
mechanism, a platform or library trap, an ordering or concurrency requirement, a security invariant
("never logged"), or the meaning of a magic number, regex or byte layout. One line; two at most.
Before writing it, ask whether a better name, a type or a test would say it instead.

Never in a comment:

- **History.** What the code used to do, "now", "no longer", "after X changed", incidents, dates, authors.
- **Tracker and rule references.** Ticket, ADR, TRD or rule IDs, PR numbers.
- **Documents as authority.** "See docs/…", or restating `docs/`: the same sentence in two files is two
  things that can disagree.
- **Rationale.** Trade-offs, "deliberately", "why not X". That belongs in the PR description or an ADR;
  a comment arguing for a design ages into one defending a design nobody proposed.
- **What the code already says.** Restated names and types, `@param x the x`.
- **Scaffolding.** Section banners, commented-out code, `TODO`/`FIXME`.
- **Test narration.** A test's comment names only a setup trap that would otherwise be "fixed" into a bug.

Always kept: tool directives (`eslint-disable`, `@ts-expect-error`, shebangs, `# syntax=`), license and
attribution headers, generated-file headers, the `# vX.Y.Z` notes beside SHA-pinned actions, and a
one-line JSDoc on the SDK's exported API where it tells a consumer something the name does not.

## Before opening a PR

The command surface is indexed in [`eng-tools/README.md`](eng-tools/README.md): the prefix says who
runs a command, with what credentials, and what a red run means. Two rules bind a new script —
**a `check:` that no workflow runs is a defect**, and **a `check:` needs no AWS credentials** — and
`pnpm run check:tool-index` fails the build on either.

CI (`.github/workflows/ci.yml`) runs on every PR and on push to `main`:

- `pnpm install --frozen-lockfile` — the lockfile must already reflect your `package.json` changes;
  run `pnpm install` locally and commit the updated `pnpm-lock.yaml` if you added/changed a dependency.
- `pnpm run build`, `pnpm run typecheck`, `pnpm run lint`, `pnpm run test` — run these locally first.
  All four go through Turborepo, which simply skips packages that don't define the script: only
  `clients/web` has `lint`, and **only `clients/sdk` has `typecheck`**, so that step covers one
  package (every other package's `build` runs `tsc`, which is the real check). Don't read a green
  `typecheck` as repo-wide coverage.
- Turborepo caches by content, so a second run of an untouched package replays its log rather than
  rebuilding. If you suspect a stale result, `turbo run <task> --force`. `test` is uncached on
  purpose — see docs/technology-stack.md.
- Infrastructure is not defined in this repository — see
  [rule 8 of `docs/invariants.md`](docs/invariants.md). If your change alters what a
  deployment has to provide (a new environment variable, a new bucket prefix, a new IAM action), say
  so in the PR description and update
  [docs/infrastructure-requirements.md](docs/infrastructure-requirements.md) in the same PR — it is
  what a self-hoster provisions from, and nothing else tracks the drift.

Run a single service's suite instead of the whole monorepo while iterating:
`pnpm --filter @scvs/<name> run test` (see ARCHITECTURE.md for the single-test-file invocation).

## Contributing from a fork

`ci.yml` is the whole gate, and it needs nothing you do not have: no repository secrets, no cloud
account, and its own Postgres 16 service container. A fork's pull request runs the same job
maintainers do, and a green run means the same thing.

Three things differ, none of them a defect in your branch:

- **The first run waits for a maintainer.** GitHub holds workflow runs from a first-time contributor
  until someone clicks *Approve and run workflows*. Nothing is wrong; nobody has looked yet.
- **No deployment or end-to-end workflow runs on your pull request**, and their absence from your
  checks is expected. Those pipelines need a live environment and a cloud role, so they live in a
  separate operations repository and are triggered deliberately after a merge — there is nothing for
  a pull request, from a fork or otherwise, to reach.
- **`check:secrets` needs a Docker daemon**, which the hosted runner provides. Locally it reports what
  it could not run rather than passing quietly; the deny-list half still runs without Docker.

Every action is pinned to a commit SHA rather than a tag. If you add a step that uses one, pin it the
same way and put the version in a trailing comment — a moved tag silently changes what CI executes.

## Documentation

Docs live in the repo, not a wiki, and they change in the **same PR** as the behaviour they
describe. A PR that moves a module boundary and leaves the design doc stale is incomplete.

Start at [docs/README.md](docs/README.md) — it maps each doc type to the one question it answers and
where it goes. In short:

- **The pull request is the record of the change.** What you did, why, and what you rejected goes in
  the description, where the diff is next to it and a reader can find both in one place. There is no
  separate per-change document to write.
- **A rule that constrains code beyond your change belongs in
  [`docs/invariants.md`](docs/invariants.md)**, as a new row. That is the test: would someone reading
  unrelated code six months from now be wrong without it?
- **A document that describes the system rather than a change** — an architecture map, a spec under
  [`docs/specs/`](docs/specs/), a guide — is updated in the same PR as the behaviour it describes.
- Before implementing a behaviour, confirm the decision authorizing it exists. If it doesn't, say so
  (`BLOCKER: <missing decision>`) rather than inventing it.

Don't create empty scaffolding. A file that exists but says nothing is worse than a missing one.

## Commits and PRs

There's no enforced commit-message tooling (no commitlint/husky), but keep the existing style: a short
imperative summary, optionally scoped — `refactor(orchestrator-svc): ...`, `fix(query-svc): ...`,
`docs: ...`, `chore: ...`. Prefer one logical change per commit over one giant diff, especially for
cross-service refactors — it makes review and `git bisect` meaningfully easier.

**No internal tracker references in a commit subject, a branch name or a PR title.** A reader outside
the project cannot open them, and unlike a comment these three cannot be corrected later. Branches are
`feat/<what-it-does>`; where a public reference helps, use the issue or pull-request number.

Keep PRs focused on one change. If a refactor and an unrelated fix both seem worth doing, split them.

PRs use a four-section template (`Summary`, `Test plan`, `Architecture impact`,
`Security / data handling impact`) — all four are required, and "None" is a valid answer for the last
two. [CODE_REVIEW.md](CODE_REVIEW.md) describes what each review gate is responsible for.

## Security-sensitive changes

If your change touches `services/builder`, its IAM roles, or anything crossing the trust boundary between
the untrusted build sandbox and the rest of the system, read [SECURITY.md](SECURITY.md) first — the
builder's zero-business-credential posture is a structural invariant, not an incidental detail, and
should never be "simplified" away.

If you're changing a shape shared with `services/builder` over the wire (`BatchJobParams`, the
`BuildArtifact`/`recipe.json` contract), note that both sides now import the *same* class from
`@scvs/core` — there is no second copy to keep in sync. Keep it that way: those two shapes must not
move into `@scvs/aws`, because `services/builder` deliberately has no AWS dependency. See
[rules 1 and 7 of `docs/invariants.md`](docs/invariants.md).

## Licensing your contribution

**No CLA, and no DCO sign-off.** Contributions are accepted under
[section 5 of the Apache License 2.0](LICENSE), which the project is already licensed under: unless
you say otherwise in the pull request, what you submit for inclusion is licensed on those terms.
There is nothing further to sign.

## Reporting bugs / vulnerabilities

Regular bugs: open a GitHub issue with repro steps. Issues are the public tracker, and a maintainer
triages them.
Security vulnerabilities: do **not** open a public issue, and do **not** open a pull request — a
pull request discloses the bug it fixes. See [SECURITY.md](SECURITY.md).
