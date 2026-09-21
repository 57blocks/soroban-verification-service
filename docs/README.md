# docs/

Two things live here: the **published contract** other software depends on, and the **guides** for
using or running this service. Nothing else — the design record and the decision history stay in the
repository this tree was exported from.

The code map is [`ARCHITECTURE.md`](../ARCHITECTURE.md).

## Using the service

| You want to | Read |
| --- | --- |
| Call this from your own code | [`integrator-guide.md`](integrator-guide.md) — picks between the SDK, the submission API, the aggregator query API and the raw result tree, and hands you to the right one |
| Submit a contract for verification | [`submission-api-guide.md`](submission-api-guide.md) |
| Query results across verifiers | [`aggregator-query-api-guide.md`](aggregator-query-api-guide.md) |
| Read a published result with no client at all | [`reading-the-result-tree.md`](reading-the-result-tree.md) |

## Running your own verifier

| | |
| --- | --- |
| [`self-hosted-deployment.md`](self-hosted-deployment.md) | Standing it up |
| [`infrastructure-requirements.md`](infrastructure-requirements.md) | What each service needs from your infrastructure, and where it is locked to a vendor. **Read §2.6 before you deploy the composer** — it and the builder must not share a network segment |
| [`verifier-onboarding.md`](verifier-onboarding.md) | Becoming discoverable to aggregators |

## The published contract

These are the interoperable part: other people's software reads them, and their `$id` values are
stable identifiers that do not change when this code moves. They moved once, on 2026-09-21, when the
deployment's own domain did (SCV-304); `results-sep/README.md`'s submission checklist rewrites them
again at number assignment, which is the rename they were always going to take.

| | |
| --- | --- |
| [`results-sep/`](results-sep/) | The result format and the aggregation surface, written as a Stellar ecosystem proposal, with JSON Schemas and worked examples |

## Specs — what this system promises, as built

[`specs/`](specs/) holds one document per area (submission, verification, build-environments,
published-results, query-and-aggregation, data-and-lifecycle, configuration): the observable
behavior and constraints that hold today, each claim followed by a `Verified by:` line pointing at
the test that proves it. Present tense, no design history — when a spec and the code disagree, the
spec is the defect.

## Invariants

[`invariants.md`](invariants.md) holds the rules that must remain true no matter how the code
implementing them is rewritten — the only standing answer to "why is the code shaped this way" that
survives a rewrite, which is why a change that establishes a new constraint should add a row there.

A change itself is recorded in the pull request that makes it. There is no separate per-change
document.
