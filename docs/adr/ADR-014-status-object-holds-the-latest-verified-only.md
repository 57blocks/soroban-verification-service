# The status object holds one entry per verifier, latest `verified` wins, and carries no extension

> **Reaffirmed 2026-09-02 by [ADR-024](ADR-024-published-contract-is-the-results-sep-we-author.md)**
> (TRD decision D9): all four decisions stand under the Results SEP we author. The reasoning for 1 and 2
> changes — no extension point and one entry per verifier are now **our** choices in **our** schema, not
> consequences of a closed foreign one — and decision 2's "deferred upstream" resolves as *upstream is
> us, and we still defer* (TRD 2.1 §5.2 gives the reasons). Decision 3 is restated in TRD 2.1 §5.2.
>
> **Status**: **Accepted 2026-08-12** (teki), under decision D2. Its `Scope:` line previously read
> "Supersedes IMPLEMENTATION-SPEC **SO8**", which ADR-011 §3 forbids — an ADR may *record* a
> TRD-level decision and never override one. Reworded before acceptance; the withdrawal now happens
> in IMPLEMENTATION-SPEC itself, and this ADR records the reasoning for it.
> **Scope**: the published `wasms/<hash>.json` status object — how many verifications it holds, which
> one survives, and whether it may carry a field the Registry API draft does not define. **Records**
> that IMPLEMENTATION-SPEC **SO8** and its `57b.candidate-sources` extension are withdrawn — by the
> 2026-08-12 amendment to that document, not by this ADR.

## Context

Three things collided.

**Source-to-bytes is many-to-one.** Two archives differing only in comments or formatting compile to
identical Wasm, and `source_sha256` hashes the *archive*, so one hash legitimately has several verified
sources. SO8 handled that by keeping the first published `verified` in the base entry and moving every
later verification into an `x_extensions` extension named `57b.candidate-sources`, ordered by
`processed_at`.

**`x_extensions` is ours, and it is not interoperable.** Checked against branch
`contract-verification-registry` on 2026-08-04: `x_extensions` appears in
`status-object-1.0.schema.json` **zero** times, in the SEP body zero times, in the README zero times,
and in none of the five published `examples/status/*.json`. We invented it. And the draft's schema sets
`additionalProperties: false` at all three levels — document, verification entry, and the `verifier`
object — so the field does not merely go *unrecognised* by a consumer validating against the published
schema; **it makes them reject the whole document**. CV6's relaxation is a rule we follow, not one we
can impose on anyone else, and CV9's base projection only helps a consumer who knows to apply it.

So SO8's candidate list was reachable only by consumers who had read our documentation. An extension
nobody else knows about is the same interoperability failure AU6 already names for signatures.

**The draft's author has opened the door, and it is the right door.** In the SEP discussion
(stellar-protocol#1944) the author confirmed nothing is settled, that more `results_urls` types can be
added, and that limiting one entry per verifier was never intended — "they all have dates and the latest
would win and be chosen as the source of truth". Which means the multiplicity question belongs upstream,
in a shared mechanism, not in a private extension shipped first and reconciled later.

## Decision

**1. The status object carries no extension field.** It is strictly conformant to the base schema for
the `schema_version` it declares. Everything richer — the full recipe, the environment provenance
block, diagnostics — lives in the **report artifact**, which is the integration point the draft
designates for verifier-specific detail and needs no upstream blessing to carry our own fields.

**2. One entry per verifier per Wasm hash.** SO8 and `57b.candidate-sources` are withdrawn. Multiple
verified sources per hash are **deferred**, not rejected: they are raised in #1944 so that whatever
lands is a mechanism every consumer can read.

**3. Latest `verified` wins — and a `mismatched` never displaces a `verified` for the same hash.**

This qualification is the load-bearing half, and plain latest-wins is unsafe without it. Anyone may
submit a verification of any contract with any source. Under unqualified latest-wins, anyone can
therefore make a legitimately verified contract read `mismatched` in the public record by submitting a
source that does not reproduce it. That is not data loss, it is **defacement of the published record**,
and dry runs do not prevent it: Rule C treats an accumulated `mismatched` as meaningful information, so
a third party publishing one is doing exactly what the design invites.

Concretely, per `(verifier, wasm_hash)`:

| Existing entry | New outcome | Result |
| :---- | :---- | :---- |
| none | `verified` or `mismatched` | the new one |
| `mismatched` | `verified` | the `verified` |
| `verified` | `mismatched` | **the existing `verified` stands**; the mismatch is not published |
| `verified` | `verified` from a different source | the newer `verified` (`processed_at` moves) |
| `mismatched` | `mismatched` from a different source | the newer `mismatched` |

Row 3 is the rule. Row 4 is why "latest" is still the right word: two verified sources are equally
true, so which one the pointer names is a freshness question rather than a correctness one.

**4. The history lives in the archive, and we accept that it is unindexed.** Every report artifact is
content-addressed at `reports/<sha256>.json`, immutable (AP2), and archived — so a superseded
verification's *evidence* persists in full. What does **not** persist is the pointer from the Wasm hash
to it.

`published-results.md` §4.1 argued the opposite case for the candidate list, in words worth keeping:
*"Stored and unreachable is the same as not stored."* That argument is not wrong, and this decision
accepts its cost knowingly rather than denying it — because the alternative is an index expressed in a
mechanism no consumer can read. "Which sources have ever verified this hash?" becomes answerable only
by enumerating the archive. The primary question — "is this contract verified, and by whom?" — is
unaffected.

## Consequences

- **Easier**: our published documents become conformant against the published 1.0 schema for the first
  time. Today they are not, by construction.
- **Easier**: SO8, `57b.candidate-sources`, the per-identifier schema hosting CV3 requires, and the
  base-projection rule CV9 requires all stop being MVP obligations. That is a whole mechanism removed,
  not deferred.
- **Easier**: it matches what the draft's author already assumed, so we stop diverging from the
  direction the SEP is heading in.
- **Harder**: a developer whose repo reproduces a contract someone else verified first gets no record of
  it under their own source hash until the upstream mechanism lands. This is the real cost and it should
  be stated to submitters rather than discovered by them.
- **Harder**: row 3 needs enforcement at publish time, which means the publish path must read the
  existing entry before writing. That is a new read on a path that currently writes blind, and it must
  be idempotent under duplicate SQS delivery like everything else there.
- **Unchanged**: the report artifact keeps every field it has. Nothing about our own record gets
  poorer; only the Registry-facing summary gets stricter.
- **Upstream-dependent, and named as such**: `results_urls` items are plain URI strings in 1.0, so the
  link to our report artifact carries neither a `type` nor a `sha256` until the structured form from
  discussion #1945 lands. Until then a consumer cannot tell which URL is the report, nor verify the
  bytes it fetches. This is the one thing this decision cannot fix from our side.

## Alternatives considered

- **Keep SO8 and the extension.** Rejected on interoperability: it is only readable by consumers who
  have read our docs, and it makes every document we publish fail strict validation against the schema
  the SEP publishes. We would be shipping a private dialect while claiming conformance.
- **Unqualified latest-wins**, as the draft's author described it. Rejected: it hands anyone a way to
  make a verified contract read `mismatched`. The fix is one row in the table above, not a different
  model.
- **Keep the first `verified` rather than the latest** (SO8's base-entry rule, minus the extension).
  Equivalent on safety and worse on freshness: a source that is deleted or moved stays pinned as the
  record forever, and re-verification cannot update it.
- **Publish a `mismatched` alongside a `verified` as two entries.** This is item 2's proper answer and
  we argue for it upstream — but it needs the multiplicity rule to exist first, or a consumer reading
  the two as contradictory picks one and hides the other, which is worse than publishing one.
- **Wait for the SEP before publishing anything.** Rejected: the base shape is sufficient for the
  primary question today, and blocking our own delivery on someone else's merge queue is not a
  trade this decision needs to make.

## References

- IMPLEMENTATION-SPEC **SO8** (withdrawn by this ADR), **CV1**–**CV9**, **AU6**, **AP2**; TRD §5.2,
  §7.6 Rule C
- `../design/published-results.md` §3, §4.1 — the argument this
  decision overrides, and the cost it accepts
- [ADR-010](ADR-010-result-root-holds-only-hash-keyed-documents.md) — the result root's admission test,
  which this decision does not change
- `packages/core/src/registry.ts` — the base shape, transcribed from the draft; unchanged by this
  decision, since it never modelled the extension
- stellar-protocol#1944, branch `contract-verification-registry`, read 2026-08-04 —
  `status-object-1.0.schema.json`, the SEP body, `examples/status/*.json`
