# Results SEP

**Two drafts since 2026-09-10, on SDF's advice** (ADR-024's third amendment): the per-verifier read
surface goes up first and on its own, and aggregation follows behind it.

| Draft | Covers | Serves it here |
| --- | --- | --- |
| [`sep-contract-verification-results.md`](sep-contract-verification-results.md) | the result root, the status object, the per-hash read route, a verifier's bulk load, the error envelope | `verification-svc`, and the static result root `orchestrator-svc` publishes |
| [`sep-contract-verification-aggregation.md`](sep-contract-verification-aggregation.md) | the aggregated document, the Trusted Verifiers List, an aggregator's bulk load and contract-address route | `query-svc` |

**The split is editorial: no document, route, field or `schema` value changed.** That is the
constraint to hold the next time either draft is edited — the wire these describe is deployed, and a
change to it is a separate decision with a separate blast radius.

The second draft depends on the first and says so in its `Dependencies`; the first mentions the
second only as forward context and is complete without it. Section numbers are per draft and
restarted at 1, so a citation must name which one.

## Schemas

The JSON Schemas the two drafts carry; TRD 2.1 §5.7 names the documents, each carrying `schema` +
`schema_version`. **Five document types in six files** — the bulk-load page is one `schema` value with
one record shape per role, see below. There were six types until 2026-09-03, when the signature
envelope was withdrawn with the signing scheme it belonged to (the decision record that argued
reproducibility is the stronger property, under the report-artifact feature). They land here one work package at a time, and this
directory is what each SEP's `schemas/` will be copied from when it is submitted — into
`contents/<sep-slug>/schemas/`, which is where upstream's `ecosystem/README.md` requires a SEP's
supporting files to live and what the drafts' links already point at. They resolve in this repository
only after that copy.

| `schema` | File | Owned by | Served at |
| --- | --- | --- | --- |
| `stellar-verification-status` | [`schemas/stellar-verification-status-1.0.schema.json`](schemas/stellar-verification-status-1.0.schema.json) | Results | the result root, and `GET /v1/wasms/{hash}.json` |
| `stellar-verification-page` | [`schemas/stellar-verification-page-1.0.schema.json`](schemas/stellar-verification-page-1.0.schema.json) | Results | `GET /v1/wasms` on a verifier |
| `stellar-verification-error` | [`schemas/stellar-verification-error-1.0.schema.json`](schemas/stellar-verification-error-1.0.schema.json) | Results | every non-2xx on an API route, **both roles** |
| `stellar-verification-aggregate` | [`schemas/stellar-verification-aggregate-1.0.schema.json`](schemas/stellar-verification-aggregate-1.0.schema.json) | Aggregation | `GET /v1/wasms/{hash}` on an aggregator |
| `stellar-verification-page` | [`schemas/stellar-verification-page-aggregated-1.0.schema.json`](schemas/stellar-verification-page-aggregated-1.0.schema.json) | Aggregation | `GET /v1/wasms` on an aggregator |
| `stellar-trusted-verifiers-list` | [`schemas/stellar-trusted-verifiers-list-1.0.schema.json`](schemas/stellar-trusted-verifiers-list-1.0.schema.json) | Aggregation | `GET /v1/verifiers` on an aggregator |

**Two files, one `schema` value, and that is deliberate.** The bulk-load envelope is shared and only
`records` differs by role, so the aggregated page is a second file rather than a `oneOf` branch: the
Results SEP must be implementable, and validatable, by a verifier that has never heard of
aggregation. Splitting them is the one schema change the split required — the page schema used to
`$ref` the aggregate across files, which would have made the first SEP depend on the second.

Three conventions every schema here follows (TRD §5.7):

- **Closed for a producer, relaxed for a consumer.** `additionalProperties: false` throughout, so a
  document of a given `schema_version` carries exactly that version's fields; a consumer validates with
  the constraint relaxed so a higher `MINOR` stays readable (IMPLEMENTATION-SPEC CV6). The code splits
  the same way — `parseStrictRegistryStatusObject` at publish, `PeerRegistryStatusObject` on read.
- **Two exceptions, argued rather than assumed, and not the same kind.**
  `stellar-verification-error` is not closed at the **document** level: its four fields are required and
  a producer may send diagnostic ones beside them, because an error body carries one field a consumer
  parses (`error`) and one for a person (`message`) and forbidding the rest would delete text the
  console displays. Argued in the submit-flow feature's decision record on why this one document is not
  closed. The aggregate's relayed entry is open at the **object** level for relay fidelity — an
  aggregator that dropped an unrecognised field would be editing the claim it is passing on.
- **Verdict-conditional fields are `if/then/else` on `status`** (SO2, SO3), not optional — an
  `unverified` entry is exactly `{verifier, status}`.

## Examples

[`examples/`](examples/) holds a non-normative response body for every document either draft
defines, in the shape **this repository's implementation actually emits** — field names, vocabularies,
message strings and the cursor format are read out of the code, not invented. They follow the Registry
API draft's naming, `<status>-<scenario>.json`, one directory per document type.

```
examples/
  results/      → contents/sep-contract-verification-results/examples/
    status/     200-verified · 200-mismatched · 202-pending
    page/       200-first-page · 200-last-page · 200-empty
    error/      400-invalid-wasm-hash · 400-invalid-cursor · 404-not-found
                · 503-storage-unavailable
  aggregation/  → contents/sep-contract-verification-aggregation/examples/
    aggregate/  200-single · 200-disputed · 200-unavailable-peer · 200-no-data
    page/       200-first-page · 200-empty
    verifiers/  200-verifiers
    error/      400-invalid-cursor · 400-invalid-network · 404-contract-not-found
                · 503-aggregation-unavailable
```

**Nested by SEP where the schemas are flat**, and the asymmetry is not an oversight: schema filenames
are globally unique (`stellar-*`), while `page/200-first-page.json` exists under both SEPs and would
collide.

**The aggregator's `page/` holds two of the verifier's three, and both halves of that are deliberate.**
An aggregator's `200-last-page` would be `200-first-page` with `cursor: null` and the same 2 KB record
copied under it, and Results §5's own `200-last-page` already demonstrates the null-cursor rule on the
same envelope — so it is not written. `200-empty` is, and for a different reason than its Results twin,
byte-identical though the two files are: it is the other half of the one MUST that is the aggregator's
own. Before it has read its list for the first time an aggregator answers `503`
`aggregation_unavailable` (`error/503-aggregation-unavailable.json`), never an empty `200` a consumer
records as synchronised and never revisits. The two files are the same route's two answers, and only
side by side do they say which is which.

**Every example is a body this deployment can actually produce.** That rule cost three candidates: one
relaying a #1944-shape peer, one relaying a peer at a higher `MINOR`, and a status object holding two
verifiers' entries. Each documented a rule the SEP states, and none described anything that exists —
nothing is published, the Trusted Verifiers List holds this operator's own environments, no verifier
anywhere runs a version other than `1.0`, and **a result root holds one entry: the verifier's own**.
An example set that mixes observed bodies with imagined ones stops being evidence, which is the only
thing it is good for. The rules stay stated in the drafts and pinned by tests (`clients/sdk`'s SO7
case, `query-svc`'s higher-MINOR retention, `registry-status-test.ts`'s verifier-keyed merge).

**Re-read against the code, the rule cost five more things.** An example set is only evidence if every
byte of it came from somewhere, so each file was checked against the site that emits it rather than
against the schema alone (the schemas pass either way — that is what makes this the check that finds
things):

- An Arweave link is `${SCVS_ARWEAVE_GATEWAY_URL}/${txId}`, not `ar://{txId}` — `gatewayUrlFor` in
  orchestrator-svc's archive service builds it, and `ar://` was carried over from the Registry API
  draft's examples. Five files.
- Every Trusted Verifiers List entry a deployment serves carries `id`, because `toTrustedVerifier`
  sets it unconditionally from the row's key; and an entry with **no** `bulk_load_url` is not served
  at all — that function throws and the caller drops the row (static-only membership is foreclosed).
  The example had neither the ids nor a `bulk_load_url` on its `paused` member.
- A `429` carrying `rate_limited` comes from the abuse guard, which is mounted on submission routes
  this SEP does not define. On §§4–5 a `429` is the global throttler, reshaped to `request_failed`.
  The file it stood in for — an error body with a diagnostic field beside the four — is now §5's
  `400 invalid_cursor`, which is a body this SEP's own route emits **and** carries `status_code`.
- `unavailable_verifiers` names only members of the aggregator's own list, so the peer one example
  reported as unreachable had to be in the list example. It now is.
- `400_other` has no producer at all: the code appears in the read route's DTO enum, the generated
  OpenAPI and **RC2**, and in no `throw` anywhere, and its `message` was written rather than read.
  Its example is deleted. §4's table and the error schema's `description` already name both members of
  that closed vocabulary, so nothing a reader needs went with it — while a fabricated body sitting in
  a set whose whole value is that it was observed costs the other twenty their standing.

Key order follows the emitting code where the code fixes it — `{name, url}` in a `verifier` block,
`schema · schema_version · verifiers · updated_at` in the list document. It is not chased into a
relayed entry, where `toEntry` spreads a stored recipe object whose own order this repository does not
pin.

Three of them exist to pin something the prose argues rather than to show a happy path:

- **`results/status/202-pending.json`** is exactly `{verifier, status}` — SO3's rule that an
  `unverified` entry carries nothing else, which is the one place a schema conditional is doing real
  work.
- **`results/error/400-invalid-cursor.json`** carries `status_code` beside the four required fields.
  That is the error envelope's document-level openness, and it is real: both services' `errorBody()`
  adds it, and only the per-hash read route's `errorEnvelope()` does not — which is why this file is
  the bulk-load route's `400` and not the read route's.
- **`aggregation/aggregate/200-no-data.json`** is a `200`, not a `404`: an aggregator that holds no
  view says so in the body, and `query-svc`'s per-hash route never 404s.

**When an example goes, the prose that named it has to go with it.** The Aggregation draft's
`Dependencies` advertised "one relaying a peer that still publishes the Registry API draft's shape"
for a day after that example was deleted — a review caught it. Deleting an example is two edits, not
one.

Two absences are deliberate:

- **No `200-unverified` status object.** The Registry API draft's example set has one; a result root
  published under these SEPs never carries `unverified` — the value exists for *reading* peers and for
  the `202` body. Shipping the example would document a document this verifier does not write.
- **No `logo_url` anywhere.** The Limitations section of the Results draft says no reference
  implementation populates it; an example that did would contradict its own SEP.

**Validating them.** `../features/read-and-aggregate/eng-tools/validate-sep-examples.mjs`
checks all 21 against the six schemas (`node docs/features/read-and-aggregate/eng-tools/validate-sep-examples.mjs`).
It is a throwaway under the feature, **not** a `check:` — nothing in CI runs it, and whether the
examples deserve a permanent gate is its own decision; read
`../features/docs-code-alignment/` before adding one.

**One check is not per-schema, and it is the one that matters.** Validating each example against its
own schema is exactly what let the aggregation set drift: `relayed_verification` is open and names six
fields, so an abbreviated relayed entry validated cleanly while contradicting the entry conditions the
Aggregation draft says it inherits (a second review found this). So
`aggregation/aggregate/200-single.json`'s entry **is** `results/status/200-verified.json`'s entry, plus
`schema_version` and `retrieved_at` and nothing else, and the validator asserts that equality rather
than trusting it. The other aggregate examples are built from the same entry.

That pair is also the answer to "what does relay actually preserve": read the two files side by side
and the answer is *everything*.

The E2E case `E2E-PUB-03` (`test/integration/support/status-schema.ts`) validates the published static
document against the status schema by a hand transcription that reads its enums and required lists from
the file, so a drift between the two fails the run rather than passing silently.

`dry-run-findings.md` is what implementing these against a real codebase
found — eleven things the SEP text has to say that the outline did not, seven the outline got right, and
what the exercise did **not** cover. It was written against the single draft and is not re-split; a
finding about aggregation now lands in the second one. The drafts' author reads it while drafting; it is
the return on aligning the code before writing the spec.

[`../registry-schemas/`](../registry-schemas/) holds the Registry API draft (stellar-protocol#1944) the
Results draft builds on — the previous target, kept as history and as **peer** fixtures.

## Submission checklist

**This file does not travel upstream** — only `ecosystem/*.md` and `contents/**` do — which is why the
checklist lives here rather than in the drafts.

The governing decision, so it is not re-raised or half-applied: **the six schemas' `$id`s and the
repository-internal citations in their `$comment`s stay exactly as they are here, and are rewritten in
the submission commit.** Fixing one of the two now and not the other is the worst of the three options,
because it leaves the file neither correct here nor correct there.

Grounded in what upstream actually merged, not in the Registry API draft alone: only three SEPs have a
`contents/` directory at all, none of them has a README, no merged SEP ships example fixtures, and the
one merged JSON Schema (SEP-42's asset list) carries **no `$id`**. So a `contents/README.md`, the
examples and `$id` are all optional; keeping `$id` is normal, it simply joins the rename step.

**Order.** The Results draft is submitted first and alone. The Aggregation draft follows once the first
has a number, because its `Dependencies` and its cross-references name that number — submitting both at
once means one of them cites a SEP that does not exist yet.

**At submission — Results**

1. Prose → `ecosystem/sep-contract-verification-results.md`.
2. Its three schemas → `contents/sep-contract-verification-results/schemas/`.
3. Scrub those `$comment`s: `TRD 2.1 §5.x`, `IMPLEMENTATION-SPEC CV6`, the rule ids
   (`CV8`/`CV10`/`RC2`/`RC6`/`SO2`/`SO3`), the feature decision-record paths, and the status schema's
   "…as **this repository's** target", which becomes false the moment "this repository" is
   `stellar-protocol`. Prefer the SEP's own section numbers — the reasoning survives, the citations do
   not need to.
4. `examples/results/*` → `contents/sep-contract-verification-results/examples/`, keeping the
   `status/`, `page/`, `error/` subdirectories and dropping the `results/` level.
5. Run upstream's `./bin/prettier.sh`.
6. `Discussion:` per whatever @fnando decides about #1945 and its thread — the draft ships pointing at
   the existing one. `Author:` stays singular: SDF's answer (2026-09-09) was to credit @fnando in the
   text and link #1944 as prior art, which the draft's *Prior art and acknowledgements* section does,
   rather than to add a co-author key.
6b. **Reset the changelog to a single `0.1.0` entry, and `Version:` with it.** Neither draft has ever
   been public, so every revision before submission is this repository's history and not the
   ecosystem's — a reader upstream cannot act on "0.2.0 — Split", because they never saw 0.1.0. The
   changelog stays complete *here*, where it is useful; it is the copy that travels that resets.
   Getting this half-right is the trap: dropping the entry while leaving `Version: 0.2.0` in the
   Preamble leaves the document claiming a version its own changelog does not mention.
7. Optional: a `contents/…/README.md`, or a "Validating" subsection in the prose.

**At submission — Aggregation**, after Results has a number

8. Prose → `ecosystem/sep-contract-verification-aggregation.md`, with every "*Contract Verification
   Results*" reference replaced by `SEP-00NN` and its section numbers checked against the merged text.
9. Its three schemas → `contents/sep-contract-verification-aggregation/schemas/`; the aggregated page's
   `$ref` to the aggregate is same-directory and needs no rewrite.
10. `examples/aggregation/*` → `contents/sep-contract-verification-aggregation/examples/`, same
    flattening. Then steps 3, 5 and 7 again, for those files.
11. `Discussion:` — a fresh thread, unless #1945 has been repurposed.

**At number assignment — one commit per SEP**

12. `ecosystem/sep-contract-verification-<slug>.md` → `sep-00NN.md`.
13. `contents/sep-contract-verification-<slug>/` → `contents/sep-00NN/`.
14. The schema links in that prose.
15. The `$id`s, if they are kept.

Steps 12–15 are one commit because a partial rename is a set of links that resolve to nothing, and
`$id` in particular fails silently.
