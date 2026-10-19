import { rebuildErrorCodeClass, type RebuildErrorCode, type RebuildErrorCodeClass } from "@scvs/core";

type Entry = { meaning: string; action: string };

const RETIRED = new Set<RebuildErrorCode>(["git_clone_failed", "git_checkout_failed"]);

const VERIFIER_SIDE = "A fault on the verifier's side. Resubmit; if it persists, report it to the verifier's operator.";
const READ_THE_LOG = "Read the build log for the cause.";

export const FAILURE_ADVICE: Record<RebuildErrorCode, Entry> = {
  source_archive_conflicting_entries: { meaning: "The archive stores the same path more than once with different contents, so which copy is the source depends on the tool that reads it.", action: "Repack the archive so each path is stored once. Repeated identical copies are accepted." },
  source_archive_extract_failed: { meaning: "The archive could not be listed or extracted.", action: "Send a valid gzip tarball or zip file." },
  source_archive_layout_invalid: { meaning: "Nothing was left in the archive once its layout was normalised.", action: "Check that the archive holds the source tree." },
  source_archive_nested_too_deep: { meaning: "Archives are nested more than four levels deep.", action: "Send the source archive itself, not an archive of archives." },
  source_archive_nested_unsupported: { meaning: "The archive's single member is not an archive the verifier can read.", action: "Send the source archive itself, as a gzip tarball or a zip file." },
  source_archive_not_chain_recorded: { meaning: "The archive's hash differs from the `source_sha256` the contract records on chain.", action: "Send the exact archive the contract was built from." },
  source_archive_too_large: { meaning: "The archive is over the size limit.", action: "Leave build outputs and vendored dependencies out of the archive." },
  source_archive_too_large_uncompressed: { meaning: "The archive expands past the size limit.", action: "Leave build outputs and vendored dependencies out of the archive." },
  source_archive_too_many_entries: { meaning: "The archive has more entries than the limit, 20,000 by default.", action: "Leave build outputs and vendored dependencies out of the archive." },
  source_archive_unreadable: { meaning: "The sizes of the archive's entries could not be read.", action: "Create the archive again and resubmit." },
  source_archive_unsafe_link: { meaning: "The archive contains a link, or another entry that is not a regular file or directory.", action: "Archive regular files and directories only." },
  source_archive_unsafe_path: { meaning: "The archive contains an absolute path or a path with `..`.", action: "Archive the source with relative paths only." },
  source_archive_unsupported_entry: { meaning: "The archive contains a special file, such as a device or a pipe.", action: "Archive regular files and directories only." },
  source_hash_mismatch: { meaning: "The bytes fetched from `source_uri` do not match `source_sha256`.", action: "Make the URL serve exactly the archive whose SHA-256 you submit — some hosts regenerate archives on each download — or upload the archive." },
  source_not_extracted: { meaning: "The source was not where the build expected it.", action: VERIFIER_SIDE },
  source_path_not_found: { meaning: "The staged source could not be found.", action: VERIFIER_SIDE },
  source_ref_unsupported: { meaning: "The source is a git repository or another kind of reference the verifier does not fetch.", action: "Give an `https` URL of an archive, or upload the archive." },
  source_stage_copy_failed: { meaning: "The verifier could not stage the source for the build.", action: VERIFIER_SIDE },
  source_uri_missing: { meaning: "The submission named no source.", action: "Give `source_uri` or `upload_id` in the manifest." },
  source_uri_not_materialized: { meaning: "Fetching `source_uri` failed.", action: "Check that the URL is reachable and serves the archive, then resubmit." },
  source_uri_refused: { meaning: "The verifier's fetch policy refused `source_uri`.", action: "Give a public `https` URL." },
  git_clone_failed: { meaning: "No longer produced; it appears only on older jobs.", action: "Resubmit with an archive URL or an upload." },
  git_checkout_failed: { meaning: "No longer produced; it appears only on older jobs.", action: "Resubmit with an archive URL or an upload." },

  absolute_manifest_path_not_supported: { meaning: "`--manifest-path` in `bldopt` is an absolute path.", action: "Give the path relative to the root of the archive." },
  manifest_path_escapes_source: { meaning: "`--manifest-path` in `bldopt` points outside the source.", action: "Give a path inside the archive." },
  recorded_build_option_unsupported: { meaning: "The build image's Stellar CLI rejects one of the build options.", action: "Drop the option if the original build did not use it." },

  sandbox_unavailable: { meaning: "The build sandbox was not available.", action: "None needed: the verifier retries automatically." },
  toolchain_probe_failed: { meaning: "The build image's toolchain could not be identified.", action: "None needed: the verifier retries automatically. If the job still ends `build_failed`, report it to the verifier's operator." },
  batch_job_failed_no_artifact: { meaning: "The build job ended without leaving a result.", action: "None needed: the verifier retries automatically." },
  added_build_option_unsupported: { meaning: "The build image's Stellar CLI rejects an option the verifier adds.", action: "Report it to the verifier's operator; retrying will not help." },
  source_archive_reader_unavailable: { meaning: "The build image lacks the tool needed to read the archive.", action: "Report it to the verifier's operator; retrying will not help." },

  rebuild_command_failed: { meaning: "The build exited with an error.", action: `${READ_THE_LOG} Check that the source builds with the toolchain the contract records.` },
  cli_failure: { meaning: "The build failed without reporting a reason.", action: READ_THE_LOG },
  artifact_output_missing: { meaning: "The build produced no Wasm.", action: READ_THE_LOG },
  artifact_report_ambiguous: { meaning: "The build produced more than one Wasm.", action: "Select one package with `--package` in `bldopt`." },
  artifact_report_disagrees_with_output: { meaning: "The build's own report and its output do not match.", action: READ_THE_LOG },
  artifact_report_hash_missing: { meaning: "The build's report gives no hash for the Wasm.", action: READ_THE_LOG },
  artifact_report_missing: { meaning: "The build wrote no report.", action: READ_THE_LOG },
  artifact_report_outside_output_mount: { meaning: "The build reported a Wasm outside its output directory.", action: READ_THE_LOG },
  bldopt_unparsable: { meaning: "A `bldopt` entry is not a single shell word.", action: "Split it into one entry per option." },
  dependency_prefetch_failed: { meaning: "Downloading the dependencies failed.", action: "Check that `Cargo.lock` resolves and that every dependency is published." },
  dependency_prefetch_policy_rejected: { meaning: "A dependency is hosted somewhere the build's network allowlist does not include.", action: "This verifier cannot fetch that dependency, so it cannot rebuild the contract. Ask its operator whether that host can be allowed." },
  ecr_auth_failed: { meaning: "The verifier could not pull the build image.", action: VERIFIER_SIDE },
  handoff_unreadable: { meaning: "The build could not read its instructions.", action: VERIFIER_SIDE },
  manifest_path_not_found: { meaning: "There is no `Cargo.toml` at `--manifest-path`.", action: "Give the path of the contract's `Cargo.toml` inside the archive." },
  offline_mode_conflicts_with_deviation: { meaning: "`bldopt` sets `CARGO_NET_OFFLINE` to something other than `true`.", action: "Remove it: the build always runs offline." },
  reported_artifact_hash_mismatch: { meaning: "The Wasm on disk does not match the build's report.", action: READ_THE_LOG },
  reported_artifact_missing: { meaning: "The Wasm the build reported is missing.", action: READ_THE_LOG },
  reported_artifact_was_pre_existing: { meaning: "The Wasm was already in the archive before the build ran.", action: "Archive the source without build outputs." },
  source_cargo_source_override_conflict: { meaning: "The source carries its own `[source]` Cargo configuration.", action: "Remove the `[source.*]` override from `.cargo/config.toml`." },
  source_not_local_for_fallback: { meaning: "The source was not available to the build.", action: VERIFIER_SIDE },
  source_sha256_mismatch: { meaning: "The staged source does not match its recorded hash.", action: VERIFIER_SIDE },
  toolchain_pin_unavailable: { meaning: "The source pins a Rust toolchain, and the build image has no rustup to honour it.", action: "Report it to the verifier's operator." },
  environment_record_incomplete: { meaning: "The build environment's record is incomplete.", action: "Report it to the verifier's operator; resubmitting will not help." },
  source_archive_canonical_unavailable: { meaning: "The verifier could not read back the archive it staged.", action: VERIFIER_SIDE },
  rebuilt_bytes_absent: { meaning: "The rebuilt Wasm could not be read back.", action: VERIFIER_SIDE },
  rebuilt_bytes_too_large: { meaning: "The rebuilt Wasm is over the size limit.", action: READ_THE_LOG },
};

const CLASSES: { cls: RebuildErrorCodeClass; title: string; status: string; note: string }[] = [
  { cls: "source", title: "Source", status: "source_unavailable", note: "The source could not be fetched or read. Not retried." },
  { cls: "policy", title: "Policy", status: "policy_rejected", note: "A build option this verifier does not accept. Not retried." },
  {
    cls: "infrastructure",
    title: "Infrastructure",
    status: "build_failed",
    note: "A fault on the verifier's side. Retried automatically, so the job can return to `queued`.",
  },
  { cls: "build", title: "Build", status: "build_failed", note: "The build did not produce a usable Wasm. Not retried, unless it timed out." },
];

const cell = (text: string) => text.replace(/\|/g, "\\|");

/** Markdown, so the codes are in the page text that search indexes. */
export const failureCodesMarkdown = (): string => {
  const codes = Object.keys(rebuildErrorCodeClass) as RebuildErrorCode[];
  const undocumented = codes.filter((code) => !(code in FAILURE_ADVICE));
  const stale = Object.keys(FAILURE_ADVICE).filter((code) => !(code in rebuildErrorCodeClass));
  if (undocumented.length || stale.length) {
    throw new Error(
      `clients/docs/.vitepress/failure-codes.ts is out of step with @scvs/core's rebuild error codes — ` +
        `undocumented: ${undocumented.join(", ") || "none"}; no longer exist: ${stale.join(", ") || "none"}`,
    );
  }
  return CLASSES.map(({ cls, title, status, note }) =>
    [
      `### ${title}`,
      "",
      `Job status \`${status}\`. ${note}`,
      "",
      "| Code | Meaning | What to do |",
      "| --- | --- | --- |",
      ...codes
        .filter((code) => rebuildErrorCodeClass[code] === cls)
        .sort((a, b) => Number(RETIRED.has(a)) - Number(RETIRED.has(b)) || a.localeCompare(b))
        .map((code) => `| \`${code}\` | ${cell(FAILURE_ADVICE[code].meaning)} | ${cell(FAILURE_ADVICE[code].action)} |`),
    ].join("\n"),
  ).join("\n\n");
};
