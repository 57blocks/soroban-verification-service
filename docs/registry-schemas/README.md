# Registry API schemas

> **Superseded as the target 2026-09-02 (TRD 2.1, decision D9).** The published contract is now the
> **Contract Verification Results SEP** we author (TRD §5, §5.7), not the Registry API draft
> these files vendor. The Results SEP's schemas — six documents, each with `schema` + `schema_version`
> — land under [`../results-sep/`](../results-sep/README.md) one work package at a time; the status object's
> (`stellar-verification-status-1.0.schema.json`) landed later, and `test/integration/support/status-schema.ts`
> now validates against it. Until then these files describe the **previous** target: keep
> reading them as the record of what #1944 said and of the local overlay we layered on it, not as what
> a conformant document must look like. Nothing here should be edited toward the SEP shape ahead of that
> change — the E2E validator that transcribes this schema would drift a second time.

`status-object-1.0.schema.json`, `error-1.0.schema.json`, and every file under `examples/` are
based on the official Contract Verification Registry API draft SEP:

- Source: [stellar/stellar-protocol#1944](https://github.com/stellar/stellar-protocol/pull/1944)
  ("Add SEP: Contract Verification Registry API")
- Commit: `a1268b48b7cb6daf36fea0a6238bdd5b4ed3b66a`
- Vendored: 2026-08-04

## `status-object-1.0.schema.json` authority

The status schema retains the upstream draft's `schema_version: "1.0"` and base verification rules,
but uses this repository's `$id` and is now an SCVS revision aligned with TRD §5.2. The upstream draft
predates SEP-58 v0.6.0 and does not define `bldarg`, `source_sha256`, `source_uri` or
`verified_source_code_uri`. Those fields are therefore included in the local schema and documented as
such in its `$comment`.

**`results_urls` is deliberately not one of them.** It stays exactly as draft 1.0 defines it — an array
of plain URI strings. The structured `{type, url, sha256?}` form is FT1 (IMPLEMENTATION-SPEC §C.1):
proposed by the draft's author in [discussion #1945](https://github.com/orgs/stellar/discussions/1945)
and **not in the draft**, which is why IMPLEMENTATION-SPEC AU1 was withdrawn on 2026-08-12 (D2) rather
than relocated — `additionalProperties: false` throughout leaves nowhere conformant to carry the hash,
and CV2's withdrawal removed the extension that briefly held it. This overlay declared the structured
form between 2026-08-23 (`a27c2c2b`) and its revert; that made a published document that satisfies the
overlay fail the `schema_version: "1.0"` it declares, which is what CV1 forbids. Restore the structured
form here only when FT1 lands upstream, and with a decision record.

This file is **not byte-for-byte identical to PR #1944** and must not be described as the upstream
schema itself. It is the schema used by this repository's TRD §5.2 publication and conformance tests.
The schema remains closed (`additionalProperties: false`); no `x_extensions` or arbitrary producer
fields are permitted. The dynamic `/api/{service}/v1/wasms/{hash}.json` route is a separate routing
decision; the schema describes the status document served from the static result root.

The upstream examples under `examples/` remain byte-for-byte reference fixtures from PR #1944. They
describe the historical draft and none of them validates against this overlay: not one carries
`source_sha256`, which TRD §5.2 makes required. That is the legitimate kind of divergence — the overlay
**adds** a requirement the draft leaves open, and a document satisfying the overlay still satisfies the
draft.

Redefining the *type* of a field the draft already defines is the other kind, and it does not survive
`schema_version: "1.0"` (CV1): our own published document would then fail the base shape it claims.
`results_urls` was the only field where this overlay did that, between 2026-08-23 and its revert —
visible in `examples/status/200-verified.json`, whose plain-string entries the overlay had started
calling invalid.

`packages/core` and `packages/storage-layout` model the same `results_urls: string[]` shape this schema
declares. They do not yet publish every other newly required TRD field, so a generated status document
must not be labelled as passing this local schema merely because it passes the DTO validation.

The local schema is authoritative over any older field description elsewhere where they conflict —
see [`docs/specs/published-results.md`](../specs/published-results.md) for what this verifier
promises about the status object. Any future upstream Registry API or SEP-58 schema update must be
reviewed before re-vendoring or changing `schema_version`.

When the upstream draft or merged SEP changes, update the source commit and the local TRD overlay
explanation in the same change; do not silently replace the local schema with an upstream snapshot.
