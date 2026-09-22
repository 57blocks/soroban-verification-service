import { createEnumGuard } from "./validate.js";

/**
 * Every failure code that can reach `rebuilds.error_code`, and which class of failure each one is.
 *
 * The codes cross a trust boundary: `services/builder` writes them into `BuildArtifact.reason` inside the
 * sandbox, `RebuildOutcomeService` records them, and `rebuildFailureReason` turns the class into the
 * `FailureReason` that decides retryability. Before this table the two ends agreed by string literal, and a
 * code with no entry on the reading side fell through to the non-retryable default in silence.
 *
 * One table, not two lists: the keys *are* the vocabulary, so a code cannot exist without a class.
 */
export const rebuildErrorCodeClasses = ["source", "policy", "infrastructure", "build"] as const;
export type RebuildErrorCodeClass = (typeof rebuildErrorCodeClasses)[number];

export const rebuildErrorCodeClass = {
  // --- source: we could not get the bytes we were asked to build, or could not trust them -----------------
  source_archive_extract_failed: "source",
  source_archive_layout_invalid: "source",
  // Both are source codes and both are permanent, which is the honest classification: the submitter
  // recompressed a source archive (a `.tar.gz.zip`), we unwrapped one level, and what was inside is either not
  // an archive we read or is another wrapper.
  source_archive_nested_too_deep: "source",
  source_archive_nested_unsupported: "source",
  // The materialiser refuses an archive that is not the `source_sha256` the deployed Wasm records, at the one
  // point the bytes are in hand.
  source_archive_not_chain_recorded: "source",
  source_archive_too_large: "source",
  source_archive_too_large_uncompressed: "source",
  source_archive_too_many_entries: "source",
  source_archive_unreadable: "source",
  source_archive_unsafe_link: "source",
  source_archive_unsafe_path: "source",
  source_archive_unsupported_entry: "source",
  source_hash_mismatch: "source",
  source_not_extracted: "source",
  source_path_not_found: "source",
  source_ref_unsupported: "source",
  source_stage_copy_failed: "source",
  source_uri_missing: "source",
  source_uri_not_materialized: "source",
  // Emitted on both sides of the boundary: `orchestrator-svc` records it when the destination policy refuses a
  // submitter's `source_uri` before dispatch, and the sandbox records it if it is ever handed a URL that is not
  // a presigned staging location.
  source_uri_refused: "source",
  // No emitter since the source fetch moved to the trusted side. Kept because this table also classifies codes
  // read off *persisted* rows, so dropping them turns an old row's clean `source_unreachable` into a
  // fall-through.
  git_clone_failed: "source",
  git_checkout_failed: "source",

  // --- policy: the recorded recipe itself is inadmissible, so the verifier refuses to replay it -----------
  absolute_manifest_path_not_supported: "policy",
  manifest_path_escapes_source: "policy",
  // Retryability does not change — both are permanent.
  recorded_build_option_unsupported: "policy",

  // --- infrastructure: the machinery failed rather than the recipe ----------------------------------------
  sandbox_unavailable: "infrastructure",
  // The toolchain probe is the first command to touch the build image, so on a cold host it pays for the pull.
  toolchain_probe_failed: "infrastructure",
  batch_job_failed_no_artifact: "infrastructure",
  // The mirror of `recorded_build_option_unsupported`: an argument *we* added that the image rejects means
  // BE11's probe (`argument-policy.ts:resolveAddedArguments`) did not cover it.
  added_build_option_unsupported: "infrastructure",
  // Reads `source_archive_*` and is deliberately **not** a source code: the archive is fine, the builder image
  // is missing the binary that reads it (`bsdtar`, for zip).
  source_archive_reader_unavailable: "infrastructure",

  // --- build: an ordinary build failure, and not retryable ------------------------------------------------
  // The honest default: whatever `run-cli.ts` could not identify, including ordinary compile failures.
  rebuild_command_failed: "build",
  // What `RebuildOutcomeService` records when a `cli_failure` artifact carries neither a `docker_error` nor a
  // `reason` of its own.
  cli_failure: "build",

  // Entries below reach `build_failed` today only because no rung claimed them. They are frozen here to keep
  // this table behaviour-identical to the three sets it replaces; several look misclassified (a failed ECR
  // auth or an unavailable toolchain pin is machinery, not a bad recipe) and are SCV-308's follow-up, not a
  // change to make while the vocabulary is being typed.
  artifact_output_missing: "build",
  artifact_report_ambiguous: "build",
  artifact_report_disagrees_with_output: "build",
  artifact_report_hash_missing: "build",
  artifact_report_missing: "build",
  artifact_report_outside_output_mount: "build",
  bldopt_unparsable: "build",
  dependency_prefetch_failed: "build",
  dependency_prefetch_policy_rejected: "build",
  ecr_auth_failed: "build",
  handoff_unreadable: "build",
  manifest_path_not_found: "build",
  offline_mode_conflicts_with_deviation: "build",
  reported_artifact_hash_mismatch: "build",
  reported_artifact_missing: "build",
  reported_artifact_was_pre_existing: "build",
  source_cargo_source_override_conflict: "build",
  source_not_local_for_fallback: "build",
  // The near-miss that motivated this table: both ends emit `source_sha256_mismatch` while the reading side
  // carried `source_hash_mismatch`, so no source-hash failure on this channel was ever a source failure.
  source_sha256_mismatch: "build",
  toolchain_pin_unavailable: "build",
  // Written by orchestrator-svc rather than the sandbox.
  environment_record_incomplete: "build",
  source_archive_canonical_unavailable: "build",
  rebuilt_bytes_absent: "build",
  rebuilt_bytes_too_large: "build",
} as const satisfies Record<string, RebuildErrorCodeClass>;

export type RebuildErrorCode = keyof typeof rebuildErrorCodeClass;

export const rebuildErrorCodes = Object.keys(rebuildErrorCodeClass).sort() as readonly RebuildErrorCode[];

export const isRebuildErrorCode = createEnumGuard(rebuildErrorCodes);

/** `undefined` for a code this build does not know — an older sandbox, or a `docker_error` passed through. */
export function classifyRebuildErrorCode(code: string | undefined | null): RebuildErrorCodeClass | undefined {
  return code && isRebuildErrorCode(code) ? rebuildErrorCodeClass[code] : undefined;
}
