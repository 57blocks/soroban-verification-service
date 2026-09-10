# `services/builder/src/modules/builder/` — module map

`run-cli.ts` was 1973 lines and four TRD 2.0 stories all had to edit it. They are logically
independent and were physically contended: without this split three people serialise on one file no
matter how the work is divided.

The split is **behaviour-preserving**. Every symbol moved verbatim, `run-cli.ts` re-exports its
entire previous public surface, and no caller or test needed editing.

## Who owns what

| File | Owning story | What it holds |
| :---- | :---- | :---- |
| `run-cli.ts` | **sandbox-hardening** | `runCli` and `runManualRebuild` — **one** path since the CLI mechanism was retired. sandbox-hardening owns the sandbox arguments spliced into the docker invocation. trusted-verdict's outcome classification survives as `classifyRunCliOutcome`, which no longer reads the CLI's prose |
| `artifact-selection.ts` | **trusted-verdict** | Which file is the rebuilt artifact, and its hash |
| `build-options.ts` | **differential-harness** | `bldopt`/`bldarg` parsing and replay, manifest paths. metadata-replay is adjacent |
| `argument-policy.ts` | **differential-harness** | BE11 register for verifier-added build arguments and container env levers |
| `sandbox-runtime.ts` | **sandbox-hardening** | Container invocation, source staging, dependency prefetch |
| `egress-policy.ts` | **sandbox-hardening** | Stage-1 prefetch egress policy |
| `toolchain.ts` | **sandbox-hardening** | Toolchain pinning, vendored-offline cargo config |
| `redact.ts` | **sandbox-hardening** | Log redaction (S18) |
| `diagnostics.ts` | shared | Diagnostics and failure-result builders |
| `run-cli.types.ts` | shared | Shapes only, no logic |
| `run-cli.config.ts` | shared | `RunCliRuntimeConfig` → env → default accessors |
| `fetch-source.ts` | **sandbox-hardening, source-storage** | Source materialisation. Holds conformance row `0.2` — the tarball checks that no-op on an attacker-supplied filename |
| `process-utils.ts`, `recipe.ts`, `upload.ts` | — | Unchanged by this split |

## Two things a reader should know

**`artifact-selection.ts` contains both the defect and its replacement.** `stellarDataHome`,
`newestWasm` and `collectWasm` are the newest-mtime directory scan conformance row `0.1` records;
`parseBuildArtifactReports` / `selectReportedArtifact` / `resolveReportedArtifact` are the build-tool
report mechanism AR1 requires, already used on the manual path. trusted-verdict's work is largely making the
verify path use the second instead of the first — they now sit in one file, side by side.

**`CONTAINER_OUT_DIR` is the single output-mount spelling.** `artifact-selection.ts` owns the constant
because AR1's containment check is there; `argument-policy.ts` imports it when assembling the build
command so the mount path and the reported-artifact guard cannot drift.

## What this split deliberately did not do

- **No decomposition of `runManualRebuild`.** It is a linear pipeline of guard clauses, long because
  each failure branch carries a large inline diagnostics literal. Extracting those would make it
  harder to read, not easier.
- **No `BuildArtifact` contract change.** That is trusted-verdict's, it is a breaking change to the
  builder↔orchestrator wire, and it carries a real design decision: `BatchJobParams.upload_url` is a
  single string while TB2 reads "one write-scoped upload target, valid for a single object" — so
  adding a second presigned URL for the rebuilt Wasm needs a decision, not a drive-by.
- **No collapse of the duplicated chain-reader** (`orchestrator-svc`'s and `verification-svc`'s
  metadata parsers). Real cross-story contention, but metadata-replay replaces that regex-over-CLI-prose
  parser entirely, so merging the current one now is work thrown away.
