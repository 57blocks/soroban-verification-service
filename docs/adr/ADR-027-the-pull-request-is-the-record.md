# ADR-027: The pull request is the record of a change; the per-feature document set retires

> **Status**: Accepted 2026-09-10
> **Scope**: where the record of a change lives, and what happens to the practice
> ADR-019 established. Supersedes ADR-019 and
> withdraws the requirements half of ADR-011's "Which to
> write" rule; the authority hierarchy itself is unaffected.

## Context

Since ADR-019, non-trivial work has been recorded under `docs/features/<slug>/` — a `design.md` or
`spec.md` carrying the requirements, a `plan.md`, `decisions/`, `updates/`. The set grew to 364 files
and took 257 commits in the last thirty days; 36 of the last hundred commits touched it. Two gates,
`check:structure` and `check:ownership`, enforce its shape, `docs/features/_TEMPLATE/` seeds it, and
three root documents state rules about it.

The practice worked because everyone writing here could read everything. Development now moves to a
public repository, and that assumption breaks in both directions. The record is full of internal
tracker references and an implementation history that serves no outside reader; the alternatives —
publishing it, or keeping it in a second private repository — either export a ticket trail or make
"docs change in the same pull request as behaviour" structurally impossible, which is the app↔infra
split we already know the cost of.

There is also a plainer observation. A pull request already carries the diff, the discussion, the
review, and a description template with four required sections. A second document describing the same
change is a second thing that can be wrong, and it is the one nobody reads first.

## Decision

**The pull request is the record of a change.** Its description says what changed, why, and what was
rejected. There is no per-change document.

`docs/features/` is **retired, not relocated**: it stays in this repository as the historical record,
is not edited further, and does not ship to the public repository. `_TEMPLATE/`, `check:structure` and
`check:ownership` retire with it — they keep running here, where they still have a subject, and are
absent from the exported tree.

What survives is `docs/adr/`. A decision that constrains code beyond the change making it is an ADR,
and the test is unchanged: would someone reading unrelated code six months from now be wrong without
it? In a repository with no history and no feature record, the ADRs become the only standing answer
to "why is this shaped this way", which is the argument for keeping them and for writing more of them
rather than fewer.

Documents that describe the *system* rather than a change — `docs/design/`, the architecture maps, the
guides — are unaffected and still change in the same pull request as the behaviour they describe.

## Consequences

- **Easier**: one place to look, and the most conventional shape for an open-source repository. A
  contributor who has never seen this project already knows how to read it.
- **Harder**: a pull-request description is only as good as its author, and unlike a document under
  review it is rarely revised after merge. `CODE_REVIEW.md`'s `Architecture impact` section is what
  keeps it honest, and it becomes more load-bearing than it was.
- **Lost**: the ability to read a feature's reasoning as one narrative rather than as a series of
  merges. That is a real loss and it is the price of the move; the ADRs are the part worth keeping and
  they are kept.
- ADR-019 is superseded rather than deleted. It records why the requirements moved into the feature,
  and that reasoning is what explains the shape of everything under `docs/features/`.
- **Requirements for post-TRD work** now live in the pull request that implements them, with the ADRs
  as the standing constraints. ADR-011's authority hierarchy is untouched: the TRD is still above a
  design document, for as long as the TRD is what the private history holds.

## Alternatives considered

- **Publish `docs/features/` too.** Process intact, both gates unchanged. One-time cost: scrubbing 176
  tracker URLs and 46 account-id occurrences. Rejected because the ongoing cost is what matters — it
  publishes an implementation record and a ticket trail no outside reader is served by, forever.
- **A second private repository.** Makes the same-pull-request rule impossible and re-creates a split
  whose cost is already measured elsewhere in this repository.
- **Feature records to Jira or Confluence.** Keeps the narrative, at the price of a second system that
  is always slightly wrong and that an outside contributor cannot see at all.
