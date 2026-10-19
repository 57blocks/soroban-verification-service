import { createEnumGuard } from "./validate.js";

export const rebuildErrorCodeClasses = ["source", "policy", "infrastructure", "build"] as const;
export type RebuildErrorCodeClass = (typeof rebuildErrorCodeClasses)[number];

export const rebuildErrorCodeClass = {
  source_archive_conflicting_entries: "source",
  source_archive_extract_failed: "source",
  source_archive_layout_invalid: "source",
  source_archive_nested_too_deep: "source",
  source_archive_nested_unsupported: "source",
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
  source_uri_refused: "source",
  // No longer emitted; kept because persisted rows still carry them.
  git_clone_failed: "source",
  git_checkout_failed: "source",

  absolute_manifest_path_not_supported: "policy",
  manifest_path_escapes_source: "policy",
  recorded_build_option_unsupported: "policy",

  sandbox_unavailable: "infrastructure",
  toolchain_probe_failed: "infrastructure",
  batch_job_failed_no_artifact: "infrastructure",
  added_build_option_unsupported: "infrastructure",
  // Infrastructure despite the prefix: the image lacks the reader binary, the archive is fine.
  source_archive_reader_unavailable: "infrastructure",

  rebuild_command_failed: "build",
  cli_failure: "build",

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
  source_sha256_mismatch: "build",
  toolchain_pin_unavailable: "build",
  environment_record_incomplete: "build",
  source_archive_canonical_unavailable: "build",
  rebuilt_bytes_absent: "build",
  rebuilt_bytes_too_large: "build",
} as const satisfies Record<string, RebuildErrorCodeClass>;

export type RebuildErrorCode = keyof typeof rebuildErrorCodeClass;

export const rebuildErrorCodes = Object.keys(rebuildErrorCodeClass).sort() as readonly RebuildErrorCode[];

export const isRebuildErrorCode = createEnumGuard(rebuildErrorCodes);

export function classifyRebuildErrorCode(code: string | undefined | null): RebuildErrorCodeClass | undefined {
  return code && isRebuildErrorCode(code) ? rebuildErrorCodeClass[code] : undefined;
}
