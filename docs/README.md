# docs/

Two things live here: the **published contract** other software depends on, and the **guides** for
using or running this service. Nothing else — the design record and the decision history stay in the
repository this tree was exported from.

The code map is [`ARCHITECTURE.md`](../ARCHITECTURE.md).

The documentation site the web image serves at `/docs/` is a separate tree,
[`clients/docs/`](../clients/docs/): pages written for people using the service rather than working on it.

## Using the service

| You want to | Read |
| --- | --- |
| Call this from your own code | The documentation site's [integrator guides](../clients/docs/src/integrators/choose-an-interface.md), which pick between the SDK, the submission API, the aggregator query API and the raw result tree |
| Submit a contract for verification | The documentation site: [`quick-start/submit-with-curl.md`](../clients/docs/src/quick-start/submit-with-curl.md) and the contract developers' guides in [`developers/`](../clients/docs/src/developers/) |
| Query results across verifiers | [`query-across-verifiers.md`](../clients/docs/src/integrators/query-across-verifiers.md) and [`interpret-multi-verifier-results.md`](../clients/docs/src/integrators/interpret-multi-verifier-results.md) |
| Read a published result with no client at all | [`read-the-result-tree.md`](../clients/docs/src/integrators/read-the-result-tree.md) |

## Running your own verifier

The documentation site's [self-hosting guides](../clients/docs/src/self-hosting/overview.md): requirements,
installing and running, the configuration reference, legal documents, and joining an aggregator. The site
publishes them once the source is public.

## The published contract

These are the interoperable part: other people's software reads them, and their `$id` values are
stable identifiers that do not change when this code moves. They moved once, on 2026-09-21, when the
deployment's own domain did; `results-sep/README.md`'s submission checklist rewrites them
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
