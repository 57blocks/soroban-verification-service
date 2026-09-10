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
stable identifiers that do not change when this code moves.

| | |
| --- | --- |
| [`results-sep/`](results-sep/) | The result format and the aggregation surface, written as a Stellar ecosystem proposal, with JSON Schemas and worked examples |
| [`registry-schemas/`](registry-schemas/) | The registry status object and error shapes |

## Decisions

[`adr/`](adr/) holds the Architecture Decision Records — why the code is shaped the way it is. In a
repository whose history begins at one commit, they are the only standing answer to that question,
which is why they are here and why a change that establishes a new constraint should add one.

A change itself is recorded in the pull request that makes it. There is no separate per-change
document.
