# `test/fixtures/registry/`

The Registry API draft's own worked examples, copied **verbatim** from
`stellar/stellar-protocol` branch `contract-verification-registry`
(PR [#1944](https://github.com/stellar/stellar-protocol/pull/1944)), fetched 2026-08-04 from
`contents/sep-contract-verification-registry/examples/status/`.

They are the authority for `packages/core/src/registry.ts`, exercised by
`packages/core/src/registry-test.ts` and `clients/sdk/test/registry-read-test.ts`. If one starts
failing after a draft update, the draft moved and our shape has to follow — do **not** edit these
files to make a test pass. Re-fetch them, and change `registry.ts` and IMPLEMENTATION-SPEC §C.5's
field table together.

**Four of the five parse, not all five — since 2026-09-10.** `200-verified.json` is the only example
carrying `results_urls`, and it carries them as bare URI strings; the consumer shape takes structured
entries only, because tolerating a string let one reach a relayed aggregate where the Results SEP's
schema types a link as an object. Both tests assert the split rather than working around it, and
`200-out-of-band.json` is the base the rest of their cases build on. The decision is
`the-read-side-accepts-structured-links-only.md`.
This is a deliberate divergence from the draft, not drift — it is the one place our shape stopped
following it.

`202-pending.json` and `200-unverified.json` are byte-identical: the draft distinguishes an enqueued
`unverified` from a settled one by HTTP status, not by body. Both are kept so a reader does not
"tidy" one away and lose that fact.
