# ADR-007: The by-hash result index and its query surface are network-independent

> **Status**: Accepted 2026-07-30
> **Scope**: `packages/storage-layout`'s published result tree, `packages/core`'s aggregation
> DTOs, `services/query-svc`'s public HTTP surface, `clients/sdk`'s aggregation functions

## Context

The published result tree had two lookup indexes, both keyed by `(network, ...)`:

- `results/by-contract/{network}/{contract_id}.json` — "what does this contract currently point
  to, on this chain"
- `results/by-hash/{network}/{wasm_hash}.json` — "has this Wasm been verified"

`wasm_hash` is `sha256` of the compiled bytes — a pure function of the bytes, with no reference to
any chain. `contract_id → wasm_hash` is a real, one-directional, time-varying mapping (a contract
can be upgraded to point at different bytes); the reverse, `wasm_hash → contract_id`, does not
exist as a lookup a verifier can do at all — a given Wasm can be referenced by any number of
contract instances, on any number of networks, and nothing about the bytes says which.

Splitting the by-hash index by network was therefore splitting a chain-independent fact along an
axis it doesn't have. Concretely: the same open-source contract Wasm, deployed unmodified to both
`testnet` and `mainnet`, would be verified twice — full sandboxed rebuild included — because the
second lookup missed under the first's network prefix, despite the underlying claim ("this source
rebuilds to these exact bytes") being identical and already proven.

`results/by-contract` keeps its network scoping: which chain a `contract_id` lives on, and what
it currently points to, are exactly the things that vary by chain. Only `by-hash` was miskeyed.

This surfaced while re-examining the `stellar contract verify` dispatch path (which contract at a time,
`--wasm-hash` vs `--id`); tracing "what does a verdict's primary key actually reference" led
directly to this index. No production data exists in this result tree yet — everything published
to date is local dev output or checked-in test fixtures — so this was a clean cut, not a migration.

## Decision

1. **`results/by-hash/{wasm_hash}.json`** — drop the `{network}` path segment and the `network`
   field from the document. Schema bumps `stellar-by-hash-result-v1` → `stellar-by-hash-result-v2`
   (breaking shape change, no dual-read compatibility layer — justified below).
2. **The `ResultPointer` entries this index holds never carry `contract_id`.** `contract_id` is
   chain-scoped identity; it doesn't belong on an index that is explicitly not chain-scoped. A
   contract's identity is `by-contract`'s job. `publishByHash` enforces this itself (strips
   `contract_id` from whatever pointer it's handed), rather than relying on every caller to build a
   contract_id-free pointer correctly.
3. **Public HTTP surface**: `GET /v1/query/hashes/:wasm_hash` and `GET /v1/results/hashes/:wasm_hash`
   (both formerly `.../:network/hashes/:wasm_hash`).
4. **`clients/sdk`'s by-hash reads** and the `VerifierManifest.results.by_hash_template` they fill
   drop `network` entirely — a verifier's own manifest publishes a hash template with no `{network}`
   placeholder. The enforcing symbol was `aggregateHashResults`; it is now
   `newClient(…).results.byHash` (our index shape) and `newClient(…).registry.byHash` /
   `statusObjectUrl` (the Registry shape), none of which takes a `network` argument.
5. **`results/by-contract`, `results/feeds`, and their routes are unchanged** — this ADR does not
   claim contract or feed data is chain-independent; only the hash index was miskeyed.

> **Note (2026-08-12, decision D7)**: `report-artifact` plan.md Phase 5 (2026-08-07) deleted the
> whole class of lookup file this ADR is written about — `by-hash`, `by-contract` and `feeds` alike —
> leaving the result root holding only hash-keyed documents ([ADR-010](ADR-010-result-root-holds-only-hash-keyed-documents.md)).
> **Every path this ADR names is gone**, `keys.ts` defines none of them, and
> `shapes.ts` records `VerifierManifest`'s templates removed. Point 5 above is now simply false: those
> files are not unchanged, they are deleted.
>
> Amended rather than superseded, and deliberately. ADR-010 is dated the *same day* as this one, so it
> never superseded anything here; what removed the files was a later feature phase. And the
> **decisions** mostly outlive their mechanisms: point 1's principle (a result index is not
> chain-scoped) is why the surviving documents are keyed by hash alone; point 2's (`contract_id` is
> chain-scoped identity and does not belong on a hash-keyed record) is now enforced by there being no
> stored address→hash mapping at all — address lookup resolves per request against the ledger. Point 3
> is half-true: `GET /v1/query/hashes/:wasm_hash` is served; `GET /v1/results/hashes/:wasm_hash` was
> removed with the pointer files, which is the whole of `RC3`'s downgrade in `trd-conformance.md`.
>
> The form of this note is copied from [ADR-008](ADR-008-rebuild-and-verdict-are-separate-entities.md),
> which carries one for **the same deletion**. That asymmetry — one ADR amended, its neighbour left
> describing a tree that no longer exists — is what docs-code-alignment F063 found, and it is the
> reason to prefer a neighbour's established treatment over inventing one.

## Consequences

**Easier**

- The same rebuilt-and-compared Wasm is looked up once regardless of how many chains it's deployed
  to, instead of once per chain.
- `results/artifacts/{sha256}.json` (already network-free) and `results/by-hash` now agree on what
  a hash-keyed record means; before this, one file in the tree was chain-independent and the index
  pointing at it wasn't.

**Harder / constrained**

- Hard schema break (`v1` → `v2`, route shape change) with **no read-side compatibility layer**.
  Acceptable only because no real data exists yet in this tree (verified before implementing: only
  `.tmp/scvs-artifacts` dev-scratch output and `test/fixtures/verifiers/*` fixtures reference the
  old shape, both updated in the same change). This ADR's hard-cut approach stops being valid the
  moment this service has a real deployed publisher bucket with live pointers in it — a future
  schema change against real data needs an actual migration path, not a repeat of this decision.
- `by-hash`'s pointers no longer answer "which contract is this" — only "did this rebuild
  succeed, and against what deployed hash was it compared." A caller who wants contract identity
  must go through `by-contract` instead. This is intentional (point 2 above), not an oversight.
- `by-contract`'s own `contract_id → wasm_hash` mapping still has no time/ledger witness (it's a
  point-in-time assertion that can silently go stale after a contract upgrade). That gap is
  unchanged by this ADR and remains open — tracked as follow-up work alongside the rebuild/verdict
  model changes, not fixed here.

## Alternatives considered

- **Keep `network` on `by-hash`, add a cross-network fallback lookup at read time** — rejected:
  papers over a wrong key with a second lookup path; every future writer still has to remember to
  write under every network the bytes might be deployed to, or the fallback silently misses.
- **Keep `contract_id` on `by-hash`'s pointers, drop `network` only from the key/path** — rejected:
  a `contract_id` without a `network` is ambiguous (the same `C...` string is a different contract
  per network), so keeping it without the scoping field that disambiguates it would be actively
  misleading, not just redundant.
- **Dual-read `v1`/`v2` compatibility shim** — rejected given no real data exists to preserve
  compatibility for; would add permanent code and test surface to support zero actual readers.

## References

- Conversation that traced `contract_id ⇄ wasm_hash` directionality to this index (this repo's
  session history, 2026-07-30 grilling on the `verify` dispatch path)
- `packages/storage-layout/src/keys.ts`, `shapes.ts`, `publish.ts`, `read.ts`
- `packages/core/src/aggregate.ts` (`AggregatedHashTarget`)
- `services/query-svc/src/modules/results/results.controller.ts`
- `clients/sdk/src/client.ts` (`results.byHash`, `registry.byHash`) and
  `clients/sdk/src/registry-read.ts` (`statusObjectUrl`) — renamed from `aggregateHashResults`;
  the constraint is unchanged and asserted in `clients/sdk/test/registry-read-test.ts`
