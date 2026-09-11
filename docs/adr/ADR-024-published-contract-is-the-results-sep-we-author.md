# ADR-024: The published contract is the Results SEP we author — verifier-keyed entries, two custody fields, structured links, declared document identity

> **Status**: **Proposed** 2026-09-02 (records TRD decision **D9**, awaiting the TRD owner's
> acceptance — a human approval is the only thing that promotes it)
> **Scope**: the published `wasms/<hash>.json` status object, the aggregated document, the TVL
> document and the read routes that serve them — everything TRD §5 and §8.2 define. **Records** a
> TRD-level decision (TRD 2.1 §5, §5.7, §8.2, §10 item 1) for the code's benefit, per ADR-011 §3; it
> decides nothing the TRD does not. **Reaffirms** [ADR-014](ADR-014-status-object-holds-the-latest-verified-only.md):
> all four decisions stand, 1 and 2 under reasoning this ADR supplies; decision 3 is restated in TRD §5.2.

## Context

**The contract we implemented was a draft nobody else deployed.** TRD 2.0 chose to implement the
Contract Verification Registry API ([stellar-protocol#1944](https://github.com/stellar/stellar-protocol/pull/1944))
"rather than defining our own read contract", and for a month every decision about the status object
was made inside that draft's constraints: `additionalProperties: false` at every level, SEP-58 v0.4.x
recipe vocabulary, `results_urls` as bare strings, a boolean `out_of_band` with two readings, and no
place for a second verification of the same hash. ADR-014 is the record of what those constraints
cost — a candidate-source list withdrawn "deferred, not rejected", a `sha256` integrity anchor
withdrawn with it (AU1), and an extension mechanism (`x_extensions`) withdrawn because emitting it made
our own document non-conformant.

**SDF asked us to write the SEP.** On 2026-09-01 SDF asked 57blocks to draft the ecosystem SEP that
tells explorers (1) how to read verification results from a verifier and (2) the shape of aggregated
results. That inverts the premise of every one of those constraints: the draft's author is now a
co-author, its discussion decisions are inherited, and "the schema has no place for X" becomes a
sentence we can change. The team decided (2026-09-02) that the SEP specifies the **ideal design** —
wire compatibility with the unnumbered draft is not a constraint, our implementation is feasibility
evidence rather than a template, and the code aligns to the SEP first so real problems surface before
the SEP is public.

**Two facts about the code made the shape of this decision, not only its direction.** First, the
status-object merge is positional: `buildWasmStatus` reads `source_code_verifications[0]` and rewrites
a single-element array (`packages/storage-layout/src/registry-status.ts:buildWasmStatus`), which is
safe only while a document holds exactly one entry and would silently drop entries 1..n the moment a
second verifier's entry appeared — an aggregated document, or a relayed peer. Second, the aggregator hard-codes `schema_version: "1.0"` on a
document that is a different shape from the per-verifier one, and relays entries with no record of the
version they were read at (`services/query-svc/src/modules/aggregation/aggregation-read.service.ts`).
Both are what a foreign draft with one document type and one entry per verifier produced; neither
survives contact with the design below.

## Decision

Recorded from TRD 2.1 §5.2, §5.5–§5.7, §7.3 and §8.2 (decision **D9**):

1. **The published read contract is the Results SEP, which incorporates #1944.** Not "supersedes" — a
   SEP cannot supersede an unnumbered PR — and not "implements": we author it, with the draft's
   author. Every field, path and identifier below is a proposal to the SEP process and normative for
   this verifier now.

> **Amended 2026-09-10 — the SEP ships as two, and the first one is the verifier read surface.**
> SDF's answer (2026-09-09) to the submission questions carried a suggestion from #1944's author:
> submit the per-verifier read API first, and the cross-verifier aggregator afterwards, because the
> second will attract materially more discussion than the first and should not hold it up. Accepted.
> *Contract Verification Results* now covers the result root, the status object, the per-hash read
> route, a verifier's bulk load and the error envelope; *Contract Verification Aggregation* covers the
> aggregated document, the Trusted Verifiers List, an aggregator's bulk load and its contract-address
> route, and names the first as a dependency. **Nothing about the wire changes** — same `schema`
> values, same routes, same fields — so no code moves; the split falls on the boundary the code
> already has, `verification-svc` and the published result root on one side, `query-svc` on the other.
> One schema change was forced by it: `stellar-verification-page` used to `$ref` the aggregate across
> files to describe an aggregator's records, which would have made the first SEP depend on the second,
> so the aggregated page is now its own file under the same `schema` value
> (`docs/results-sep/schemas/stellar-verification-page-aggregated-1.0.schema.json`). Decision 5's
> "every SEP document declares `schema` and `schema_version`" is unchanged and now spans two SEPs that
> version independently. The same answer settled the authorship question this ADR did not raise:
> `Author:` stays singular and #1944 is credited as prior art in the text, its disposition left to its
> author. [`docs/results-sep/README.md`](../results-sep/README.md) carries the submission order and
> what each step now applies to.

2. **Entries are keyed by verifier, one per `(verifier, wasm_hash)`, and carry no history.** The
   headline follows ADR-014 decision 3 unchanged (latest `verified` wins, `mismatched` never displaces
   `verified`). A per-entry `history` was in the team-approved outline and is **declined** for 1.0: it
   answers a question no consumer has asked; the report artifacts and bulk load already answer the audit
   question; a `mismatched` against another source says nothing about a contract whose `verified`
   stands; and it would be the document's one unbounded field under open submission, needing a cap, an
   omission counter and a policy knob to stay honest. ADR-014 decisions 2 and 4 stand — upstream is us,
   and we still defer. Adding the field later is a `MINOR`.
3. **`out_of_band` is replaced by `recipe_source` and `image_trust_level`** — the two signals TRD
   §7.3 already separates — required on every entry that carries a verdict and omitted on an
   `unverified` one, like `source_sha256` and `processed_at` (spec SO3; RC3's `202` body is
   the entry that exercises the exemption). TRD §10 item 3 closes.
4. **`results_urls` entries are `{type, url, sha256}`**, `type` ∈ `report` | `provenance`
   | `attestation` | `sbom` | `audit`; `sha256` is required on every entry pointing at content we
   published, and entries are appended, never reset. AU1 is un-withdrawn. Signing is decided (detached
   ed25519, key in the TVL entry as a Stellar strkey, `type: "signature"`) and sequenced last.

> **Amended 2026-09-03 — the signing half of this decision is withdrawn.** Decision 5 answered *how*
> to sign without anyone having asked *whether* to. The answer is no: a verification result is a claim
> the reader can re-run from the published recipe, so signing it substitutes *who said it* for *you can
> check it*; and the signature's trust anchor would have been the same Trusted Verifiers List that
> already supplied the result root a consumer reached over TLS — a second link on a closed chain rather
> than an independent root. AU1's `sha256` on every `results_urls` entry is what actually attributes an
> archived copy, and it stays. The SEP drops from six documents to five, `results_urls` loses the
> `signature` type, and the TVL entry loses `public_key`. Spec AU3–AU7 carry the withdrawal;
> `verification-results-are-not-signed.md`
> carries the argument and what would reopen it. Everything else in this ADR stands.

> **Amended 2026-09-04 — `results_urls` and `verified_source_code_uris` gain a storage-location axis.**
> Today a `results_urls` entry naming this verifier's own copy of a report and the entry naming its
> Arweave copy are both `type: "report"`, distinguishable only by inspecting the URL's scheme/host —
> `type` was never asked to carry *where*, only *what*. `results_urls` entries gain an optional
> **`location`** ∈ `verifier_self_storage` | `arweave`, structural where it was implicit; `type`'s
> content-category vocabulary (`report` | `provenance` | `attestation` | `sbom` | `audit`, FT1, sourced
> from upstream discussion #1945) is untouched — the two axes answer different questions and neither
> subsumes the other. `location` is optional because a peer's link may not classify into either bucket,
> and we only assert it where we are confident (our own publishes, our own Arweave archive appends). The
> value is `verifier_self_storage`, not `cdn` (corrected same day): the same lesson
> `dry-run-findings.md` §1.4b already drew about `cdn_root` applies
> here — nothing about this axis requires a CDN, only that the bytes live in storage the publishing
> verifier itself controls, and a public vocabulary should not assume today's implementation.
> `verified_source_code_uris` entries, bare `string[]` until now, become structured `{location, url}` on
> the same vocabulary — no `type`, since every entry there is already "a copy of the source" with no
> content-category question to answer; no `sha256` (also corrected same day), since the entry's parent
> already carries `source_sha256` over the same bytes and a per-entry digest here would be redundant;
> and `location` is required on the producer side because every entry is one we publish ourselves. Code:
> `packages/core/src/registry.ts` (`RESULT_URL_LOCATIONS`, `RegistryResultUrl.location`,
> `RegistrySourceCodeUri`), `packages/storage-layout/src/publish.ts` (`appendArchiveReference`,
> `appendVerifiedSourceCodeUri`), `services/orchestrator-svc/src/modules/publish/publish.service.ts`,
> `services/orchestrator-svc/src/modules/publish/arweave-archive.service.ts`.
5. **Every SEP document declares `schema` and `schema_version`**, six schema identifiers, all starting
   at `1.0`; an aggregate versions its envelope only and relays each entry's own `schema_version`.
   `.json` marks a static document; dynamic routes carry no suffix (`/v1/wasms`, an aggregator's
   `/v1/wasms/{hash}`, `/v1/verifiers`). `GET /v1/verifiers` is a MUST for an aggregator.
6. **No vendor-extension point in 1.0** — ADR-014 decision 1 survives in effect, for a different
   reason: what a verifier needs beyond the contract goes in its report artifact, which the SEP links
   and does not define. A namespaced extension object is argued for a later MINOR in the SEP's Design
   Rationale.

**Sequencing, which is the part an ADR is for.** IMPLEMENTATION-SPEC is amended first (ADR-011 §3
reserves rule withdrawal and reinstatement to it — AU1 returns there in new form, SO8 stays
withdrawn), this ADR records it, and code follows in this order: verifier-keyed merge
**before** any multi-entry document, structured `results_urls` **before** signatures, the envelope discriminator **before** any
route rename a consumer might pin. Old paths and the draft shape stay served as aliases through the
transition with a dated removal note; the SEP ships a non-normative Migration appendix mapping the
draft's fields onto these.

## Consequences

- **Easier**: the two integrity gaps ADR-014 named as "the one thing this decision cannot fix from our
  side" — no `type`, no `sha256` on a link — are fixed from our side.
- **Easier**: the aggregator's dual-`"1.0"` ambiguity and its silent re-versioning of relayed entries
  both disappear with the `schema` discriminator and per-entry `schema_version`.
- **Harder**: the merge must become verifier-keyed under duplicate SQS delivery and process-local
  locking (`withWasmStatusLock` is not cross-replica); the publish path
  gains a real read-modify-write on a multi-entry document.
- **Harder**: the archive backfill must advance the document's `updated_at`, not only the job row's
  `published_updated_at` — a peer reading the document sees the stale clock today.
- **Harder**: every route rename lands in the controllers, both startup route logs, the abuse guard's
  path set, the console's hooks, three TVL config files, the ALB routing check and the E2E route
  helper. The aliases exist so this can be staged.
- **Harder, and deliberately last**: a signing key is the first `secret: true` credential on the
  publish path — ADR-012/ADR-013 govern its manifest entry (`observable: never`), ADR-002 keeps it out
  of the builder and composer, ADR-018 makes it a deploy-time trust input.
- **Unchanged**: the report artifact's shape, immutability and content addressing; ADR-010's admission
  test (the `.sig` is a fourth hash-keyed class, admitted because a stale copy is incomplete, not
  wrong); the verdict rules of TRD §7.

## Alternatives considered

- **Keep implementing #1944 and propose changes to it.** Rejected: the draft is unnumbered, its author
  is co-authoring the replacement, and every field we needed was already tiered FT1/FT2 as "not in the
  draft". Proposing changes to a draft nobody else deployed is the SEP process with extra steps.
- **Wire-compatible evolution — status object `1.1`, `out_of_band` deprecated in place.** Rejected: it
  taxes every future consumer for compatibility with a document that had no consumers. The Migration
  appendix serves the one consumer that exists (us).
- **A per-entry `history` of every published verification** (the outline's proposal). Declined for 1.0
  — decision 2 gives the four reasons. Its bounded variant (`verified` items only) serves one weak case
  and was declined with it. **A separate history document in the result root** was rejected earlier by
  ADR-010's admission test and stays rejected.
- **Keep the aggregated route's `.json` because the per-verifier one has it.** Rejected: the
  per-verifier `200` *is* the static document's bytes; the aggregate is assembled per request with
  `unavailable_verifiers` reflecting that fetch. Same suffix on both would say they are the same kind
  of thing.
- **Sign the status object too.** Deferred (AU7): a signature over a mutable document verifies after a
  rollback; the fix is a decision about monotonic counters and staleness policy this ADR does not take.

## References

- TRD 2.1 §1.2, §5 (revision note), §5.2, §5.5–§5.7, §7.3, §8.1–§8.2, §10 items 1, 3, 5
- IMPLEMENTATION-SPEC §C (CV1–CV11; SO8 left withdrawn), §D.4 (AU1, AU4–AU6), §F.2 — amended 2026-09-02
- [ADR-014](ADR-014-status-object-holds-the-latest-verified-only.md) — reaffirmed; decisions 1 and 2 under this ADR's reasoning
- [ADR-010](ADR-010-result-root-holds-only-hash-keyed-documents.md) — amended for the `.sig` class
- ADR-011 §3 — why the withdrawals are reversed in IMPLEMENTATION-SPEC and only recorded here
- `SoVe/docs/sep-contract-verification-results-outline.zh.md` (v3, team-approved 2026-09-02) — the outline this records; the English SEP draft is tracked separately
- `packages/storage-layout/src/registry-status.ts:buildWasmStatus`, `services/query-svc/src/modules/aggregation/aggregation-read.service.ts` — the two code facts in Context, at `ff8d747`
