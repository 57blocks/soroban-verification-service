# Published results

As built. See `Verified by:` on each claim.

Scope: what this verifier publishes as static, hash-keyed documents, and the guarantees that hold
regardless of implementation. The wire format itself — field names, JSON Schemas, examples — is
[`docs/results-sep/`](../results-sep/README.md); this document does not restate it. The aggregated read
surface across verifiers is out of scope here (see the query-and-aggregation spec).

## 1. The result root is the interoperability primitive

A verifier's result root is a publicly readable HTTPS base path serving static documents. Discovery
needs no central database: a result for a known Wasm hash is a static document at a derivable path,
readable directly by a consumer that trusts no aggregator.

Layout:

```
<result-root>/
├── wasms/<wasm_hash>.json          per-wasm status object (mutable index)
├── reports/<report_sha256>.json    full report artifact, immutable
├── sources/<source_sha256><ext>    stored public source
├── verifier-manifest.json          verifier identity (regenerated every publish)
└── policy.json                     declared verification policy (regenerated every publish)
```

Every entry is keyed by a hash, except the two fixed-name singletons — see
[rule 14](../invariants.md) for the admission test any future addition must pass.

*Verified by:* `packages/storage-layout/src/keys.ts`, `packages/storage-layout/src/publish.ts`.

## 2. Only a verdict is published

Only `verified` or `mismatched` — reached by a build inside a declared trusted image with a
completed byte-for-byte comparison — is ever published. Every other outcome is a job-level failure:
returned to the submitter, retained in the job store, never published, never archived. A hash with
no settled verdict returns `404` from the result root, not a document with an `unverified` status.

*Verified by:* `test/integration/cases/pub/pub-status-and-report.spec.ts` (`/status_vocabulary`,
`/at_least_one_entry`).

## 3. The status object

`wasms/<wasm_hash>.json` holds one entry per verifier ([rule 19](../invariants.md)); latest `verified`
wins except a `mismatched` never displaces an existing `verified` ([rule 20](../invariants.md)). A
field is present only when the fact it reports was actually established: `rebuilt_hash` only on
`mismatched`, custody fields (`recipe_source`, `image_trust_level`) omitted for `unverified`.

*Verified by:* `packages/storage-layout/src/registry-status.ts` (`buildWasmStatus`),
`test/integration/cases/pub/pub-status-and-report.spec.ts` (`/rebuilt_hash_only_when_mismatched`,
`/processed_at_omitted_for_unverified`, `/bldopt_equals_form`).

## 4. The report artifact

Immutable, content-addressed at `reports/<sha256>.json`. It carries recipe provenance and trust
signals the status object does not. Two properties that must survive any rewrite:

- **The artifact never contains its own hash.** Integrity is anchored by the filename and by the
  `sha256` on the `results_urls` entry that points at it — never a self-reference, so there is no
  canonicalization requirement.
- **The artifact records only facts true at verification time.** Anything that changes later (an
  archive reference arriving, a source going dark) lives in the mutable status object, never here.
- **The artifact is unsigned.** Integrity is checkable via `sha256`; the artifact does not
  self-attribute to a signing key.

*Verified by:* `packages/storage-layout/src/publish.ts` (`serializeReport`, `publishReport`),
`test/integration/cases/pub/pub-report-immutability.spec.ts` (`/hash_matches_results_urls`,
`/no_self_hash`, `/bytes_stable`).

## 5. Archive publishing is two-phase and never mutates a published artifact

Results are archived to decentralized storage as the long-term record. HTTPS publication happens
first and never blocks on the archive provider; the archive reference is added afterward as a
`results_urls` entry on the mutable status object — the report artifact itself is never rewritten
to add it. The archived bytes are the exact published report bytes, so both copies hash to the same
`sha256`. A pending archive is durable and retried by a recovery scan; a process restart cannot
silently drop one.

*Verified by:* `services/orchestrator-svc/src/modules/publish/archive-once.ts`,
`services/orchestrator-svc/src/modules/publish/arweave-archive.service.ts`,
`services/orchestrator-svc/src/modules/scheduler/archive-recovery.scheduler.ts`.

## 6. Bulk load is a served route, not a file

`GET /v1/wasms` answers a cursor-paginated stream, sorted by publication update time (not job
completion time) and tie-broken by `wasm_hash`. An archive-reference backfill advances a record's
publication time without changing its completion time, so a completion-time cursor would never
re-deliver it to an already-synchronized consumer. Consumers upsert by `wasm_hash`: a record may
legitimately reappear with a later update time. The `.json`-suffixed route is a deprecated alias
(`Deprecation`/`Sunset` headers) of the same handler.

*Verified by:* `services/verification-svc/src/modules/bulk-load/own-bulk-load.controller.ts`,
`test/integration/cases/pub/pub-layout-and-bulk-load.spec.ts` (`/cursor_format`,
`/no_duplicate_cursor_keys`, `/sorted_by_publication_update`).

## 7. What the result root deliberately does not contain

Bulk-load enumeration and contract-address → Wasm-hash lookup are never published as static files,
because a stale copy of either would be *wrong*, not merely incomplete (an archive backfill mutates
publication order in place; a contract's deployed hash changes on upgrade). Both are served
routes instead. See [rule 14](../invariants.md)'s staleness test for the general form of this rule.

*Verified by:* `test/integration/cases/pub/pub-layout-and-bulk-load.spec.ts` (the "has no
`by-contract`/`by-network` file" probes).
