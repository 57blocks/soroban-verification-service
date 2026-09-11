# Code review

Two gates. An AI review is **advisory** and must be answered. A human approval is **binding** and is
the only thing that permits a merge.

## Gate 1 — AI review (advisory)

An agent may review any PR. Its findings are input, not instructions.

**The author must respond to every finding**, in one of two ways:

- fix it, or
- reply `AI-rebuttal: <why this is not a problem here>`.

An unanswered finding blocks the human gate. The rebuttal is the point of the exercise: it forces
the author to have actually considered the case, and it leaves the reasoning in the PR for whoever
reads it next.

### An AI reviewer must not

- **Approve a PR.** It has no merge authority. Ever.
- **Raise style issues the formatter or linter already owns.** If the tooling is silent, it is not a
  finding.
- **Post large patches in comments.** Describe the problem and point at the location; the author
  writes the fix.
- **Report speculative findings without a concrete failure path.** "This could be a race" is noise.
  "If two SQS deliveries for the same job arrive concurrently, both read `queued` and both dispatch"
  is a finding.
- **Restate what the diff does.** A summary is not a review.

Bounding the reviewer matters as much as bounding the author. An AI review that produces thirty
low-confidence comments trains everyone to skim it, which costs more than not running it.

## Gate 2 — human review (binding)

Approving asserts all four of these. If you cannot, do not approve:

1. **I read the changed lines** — not just the description.
2. **I understand why the change is shaped this way**, and it is consistent with the design docs and
   ADRs governing the area.
3. **I considered the failure modes and the data impact** — what happens on partial failure, retry,
   duplicate delivery, or malformed input; and what happens to data already written.
4. **I checked CI** — and did not wave through a red run as "unrelated" without evidence.

## What review is actually looking for

In rough priority order:

1. **Correctness under failure.** The happy path is usually fine. Retries, duplicate SQS deliveries,
   partial writes, and malformed submitted input are where this system breaks.
2. **Trust boundary integrity.** Did the sandbox gain a dependency, a credential, or a decision it
   should not have? Did a verdict move to the untrusted side? See
   [rule 1](docs/invariants.md).
3. **Contract changes.** A changed DTO can silently change the generated OpenAPI, the published
   artifact format, or a persisted shape. Ask whether `pnpm run generate:api-client` output moved,
   and whether existing stored data still validates.
4. **Decision authority.** If the change establishes a new pattern or removes a constraint, is there
   a rule for it in [`docs/invariants.md`](docs/invariants.md)? If not, that is the review comment.
5. **Docs in the same PR.** A boundary moved and the design doc did not — incomplete.
6. Then the ordinary things: naming, dead code, test coverage of the actual risk.

## Sensitive surfaces

These require a human reviewer familiar with the area, and a `Security / data handling impact`
section in the PR that says something specific:

- the sandbox boundary and everything it depends on
- the trust and image policy
- IAM roles and their separation
- the public HTTP surface and generated OpenAPI
- database migrations
- the published artifact and result-tree format
- credential and presigned-URL handling

## PR description

Four sections, all required — see [`.github/pull_request_template.md`](.github/pull_request_template.md).
`Architecture impact` is the one that does real work: it is what forces the author to notice that a
doc has gone stale.

"None" is a valid answer to `Architecture impact` and `Security / data handling impact`. Deleting
the heading is not.

## Merging

- CI green, or a written explanation of why a failure is unrelated — with evidence, not assertion.
- All AI findings fixed or rebutted.
- One binding human approval.
- Never merge your own PR without another human's approval.
- Never merge directly to `main`.
