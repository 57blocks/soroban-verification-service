# Integrator guide

> **Audience**: a developer who wants their own application to query verification results, or submit a
> contract for verification, programmatically. **This page is a map, not a reference** — it tells you
> which of the four ways to integrate you actually need, and links to the document that covers it in
> full.

## Which interface do you need?

| If you want to... | Use | Covered in |
| --- | --- | --- |
| Query results in TypeScript/JavaScript, with typed responses and error handling already done for you | `@scvs/sdk` | [`clients/sdk/README.md`](../clients/sdk/README.md) |
| Submit a contract for verification, or check/stream a job's status | verification-svc's submission API | [`docs/submission-api-guide.md`](submission-api-guide.md) |
| Query an aggregator's results over plain HTTP, from another language or without the SDK | query-svc's aggregation API | [`docs/aggregator-query-api-guide.md`](aggregator-query-api-guide.md) |
| Read a published result with no API at all — just static files | The raw result tree | [`docs/reading-the-result-tree.md`](reading-the-result-tree.md) |

Most integrators start with the SDK — it's the one interface that already handles pagination, error
shapes, and URL construction for you. Reach for the others when you need something the SDK doesn't
cover (submitting a verification — the SDK is read-only by design) or when you're not in a
TypeScript/JavaScript runtime.

## What every integrator should know before choosing

- **Submitting and reading are two different interfaces**, on two different services. `@scvs/sdk` is
  explicitly a *query* client — "not a submission client," per its own README. If you need to submit a
  contract, that's [`docs/submission-api-guide.md`](submission-api-guide.md) regardless of whether you
  also use the SDK to read the result afterward.
- **The raw result tree is not a fallback for when the API is down** — it's the primitive the API
  itself reads from. Prefer it when you want zero dependency on any one verifier's or aggregator's
  service being up.
- **What can be verified today**: two of three contract classes are in scope — `cli-58` (built with
  `stellar contract build --verifiable`, full on-chain recipe) and `cli-legacy` (Stellar CLI build,
  toolchain identity only, recipe submitted alongside source). Plain `cargo build` with no Stellar CLI
  record at all (`cli-none`) is out of scope for now.

## End-to-end: submit, then read the result

Tying the submission and read sides together, since that narrative doesn't live in either split-out
document on its own:

1. **Submit** via [`docs/submission-api-guide.md`](submission-api-guide.md) — `POST .../v1/verifications`
   returns a job ID immediately.
2. **Track it** — poll `GET .../v1/verifications/:job_id` or subscribe to its SSE event stream.
3. **Once terminal, read the published result** from the verifier's Result Publishing surface — a
   separate service from the one you submitted to. Use `@scvs/sdk`'s `client.registry.byHash(...)`, a
   direct call per [`docs/aggregator-query-api-guide.md`](aggregator-query-api-guide.md), or a raw
   fetch per [`docs/reading-the-result-tree.md`](reading-the-result-tree.md) — pick whichever fits the
   rest of your stack.
4. **Confirm the two views agree** — the terminal status from step 2 and the published result from
   step 3 describe the same verification reached two independent ways, and should never disagree. If
   they do, that's worth reporting, not silently working around.

If you only ever need step 3–4 — reading results someone else already produced — skip straight to the
SDK and the guide for whichever interface fits; you don't need anything from the submission side at
all.
