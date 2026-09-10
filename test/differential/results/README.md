# Differential Result Manifests

The differential workflow writes one host manifest per run here when T2 is enabled. Manifests are
compared by `services/builder/test/differential/reproducibility.spec.ts`.

## How the comparison actually gets run

`runner.ts:recordHostResult` writes `<host-label>.json` — `{fixture id: {sha256, reference_alignment}}` for
every fixture whose legs matched — whenever `SCVS_DIFFERENTIAL_HOST_LABEL` is set, so a normal harness run
already produces one. The spec compares *every* manifest in this directory and needs **at least two**, which
is why it stays skipped behind `SCVS_DIFFERENTIAL=1` *and* `SCVS_COMPARE_HOST_MANIFESTS=1`: with one manifest
it can only fail on its own precondition, which is evidence of nothing.

`plan.md` §3 — "the same harness run twice with
different `--host-label`, then `reproducibility.spec.ts` compares the two **committed** manifests. No third
mechanism" — so the sequence is:

1. Dispatch `differential.yml` with a `host-label` and the compare switch **off**. Commit the
   `differential-host-manifest-<label>` artifact's JSON into this directory.
2. Dispatch again with a *different* `host-label` and `compare-host-manifests: true`. That run writes its own
   manifest beside the committed one and compares the two.

A manifest holds only hashes the run itself produced, so a fixture present on one side and missing on the
other is a mismatch the spec reports, not a hole it skips — and the two runs must therefore pass the same
legs, not merely agree on the legs they share.
