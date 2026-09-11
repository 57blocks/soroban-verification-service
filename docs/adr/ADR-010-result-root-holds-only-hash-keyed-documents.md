# ADR-010: The published result root holds only hash-keyed documents

> **Status**: Accepted 2026-07-30 (decided in TRD 2.0 §5.1, PR #6; recorded here because later
> publishing work will be tempted to violate it)
> **Scope**: `@scvs/storage-layout`'s published-tree conventions; the Result Publishing layer;
> what may ever be added to the result root

## Context

The result root — the static, publicly readable file tree that is the interoperability primitive
between verifiers — originally listed two files whose correct content varies with time
independently of any hash: a bulk-load page chain (`wasms.json`, an *ordering* over publication
time) and per-address pointers (`contracts/<network>/<id>.json`, address → current Wasm hash).

Both are wrong when stale, not merely incomplete. The bulk-load ordering is mutated in place by
archive-reference backfill, so a materialised page chain must rewrite every sealed page behind a
moved record or silently break its pagination contract. A cached address→hash pointer, after a
contract upgrade, attributes a verified verdict to code that is no longer deployed — precisely why
the Registry API excludes address lookup.

## Decision

**Every record document in the result root is keyed by a hash** — a Wasm hash, the report
artifact's own sha256, or `source_sha256` — and nothing in it is keyed by a contract address or by
a position in an ordering. The root additionally carries exactly two fixed-name singleton identity
documents that TRD §5.5 requires — `verifier-manifest.json` and `policy.json`, the root's
self-description; `policy.json` must be generated from live configuration precisely because a stale
copy of it would be wrong. The admission test for everything else: *a stale copy of a hash-keyed
document is at worst incomplete; if a stale copy of your document would be wrong, it is a served
route (or, for the two identity singletons, regenerated on every publish), not a new file class.*

Enumeration (`GET /v1/wasms.json`, cursor over publication update time) and address lookup
(`GET /v1/contracts/{network}/{contract_id}`, resolved per request against the ledger) are served
routes only. Both capabilities remain delivered — they are RFP requirements — in dynamic form.

## Consequences

- Hash-keyed documents can sit behind a CDN with long TTLs and be mirrored without coordination;
  per-hash reads survive the publishing verifier's outage.
- **Enumerating a verifier requires that verifier to serve its bulk-load route.** A verifier
  publishing only static files can be read per hash but not synchronised. Accepted deliberately;
  a static, append-only page-chain design is named as Phase 2 (TRD §9.3) with the constraint that
  sealed pages are immutable and a `wasm_hash` may appear more than once.
- Anyone proposing a new file in the root answers the staleness test first. "It would be
  convenient to publish X" is not an argument if a stale X misleads.
- The code-current tree (by-contract indexes, feeds) predates this decision and migrates as part
  of TRD-2.0 result-layout alignment; nothing has been published publicly yet, so there is no
  stored-data cost.

## Amendment 2026-09-02 — a fourth hash-keyed class, and the suffix that marks the test

TRD 2.1 (decision D9, [ADR-024](ADR-024-published-contract-is-the-results-sep-we-author.md)) adds
`reports/<report_sha256>.sig` — a detached signature over the report's bytes, keyed by the hash of what
it signs. It passes the admission test above: a stale copy of a `.sig` is incomplete (a consumer lacks
attribution), never wrong, because the bytes it signs are themselves content-addressed and immutable.
The class was anticipated by IMPLEMENTATION-SPEC AU4 in 2026-08; this amendment records that it is now
specified, not only reserved.

The same revision makes the test visible in the path: **a `.json` suffix marks a document a static origin
can serve as-is — exactly the documents this decision admits to the root — and a dynamic route carries
no suffix** (TRD §5.7). The two served routes this decision names therefore become `GET /v1/wasms` and
`GET /v1/contracts/{network}/{contract_id}`; the decision itself does not change, its two routes were
just named with a static-file idiom. The Registry API draft cited in Context for "why address lookup is
excluded" is incorporated by the Results SEP, which keeps that exclusion.
