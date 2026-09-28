/** Job vocabulary: `mismatch`, not the published `mismatched`. */
export type JobStatus =
  | "queued"
  | "running"
  | "verified"
  | "mismatch"
  | "build_failed"
  | "source_unavailable"
  | "policy_rejected"
  | "not_attempted";

export const TERMINAL_JOB_STATUSES: readonly JobStatus[] = [
  "verified",
  "mismatch",
  "build_failed",
  "source_unavailable",
  "policy_rejected",
  "not_attempted",
];

export type RegistryStatus = "verified" | "mismatched" | "unverified";

export type FailureReason =
  | "policy_rejected"
  | "unsupported"
  | "missing_fields"
  | "source_unreachable"
  | "build_failed"
  | "build_timeout"
  | "internal_error";

export interface VerificationTarget {
  network: "mainnet" | "testnet";
  contract_id?: string;
  wasm_hash?: string;
}

export interface SubmittedManifest {
  schema: "stellar-submitted-source-verification-manifest-v1";
  bldimg?: string;
  bldarg?: string[];
  bldopt?: string[];
  source_sha256: string;
  source_uri?: string;
  upload_id?: string;
  is_public?: boolean;
}

export interface SubmitBody {
  target: VerificationTarget;
  manifest?: SubmittedManifest;
  dry_run?: boolean;
}

export interface SubmitQueued {
  status: "queued";
  job_id: string;
  target: VerificationTarget;
  build_log_token?: string;
  message?: string;
}

export interface SubmitIncomplete {
  status: "incomplete";
  target: VerificationTarget;
  missing_fields: string[];
  message?: string;
}

export interface JobStatusBody {
  job_id: string;
  status: JobStatus;
  created_at: string;
  updated_at: string;
  target: VerificationTarget;
  result?: VerificationResultSummary;
  error?: string;
  progress?: { step: string; detail?: string };
  stream_timeout?: boolean;
}

export interface VerificationResultSummary {
  status_summary?: string;
  wasm_hash?: string;
  expected_wasm_hash?: string;
  rebuilt_wasm_hash?: string;
  matched?: boolean;
  contract_binding_drifted?: boolean;
  verification_path?: "metadata_backed" | "retroactive_manual";
  verify_attempt_reason?: string;
  source_reconstruction?: {
    outcome: "adopted" | "hash_mismatch" | "failed";
    detail?: string;
  };
  evidence_source?: "wasm_metadata" | "user_submitted_manifest";
  sandbox_diagnostics?: Record<string, unknown>;
  reason?: string;
  detail?: string;
  artifact_url?: string;
  artifact_sha256?: string;
  arweave_tx_id?: string;
  verified_at?: string;
}

export interface UploadSourceResponse {
  upload_id: string;
  expires_at: string;
  max_size_bytes: number;
  filename: string;
  size_bytes: number;
  source_sha256: string;
}

export interface RegistryStatusObject {
  schema?: string;
  schema_version: string;
  wasm_hash: string;
  updated_at: string;
  source_code_verifications: RegistryVerification[];
}

export type RegistryResultUrl = string | { type: string; location?: string; url: string; sha256?: string };

export const linkUrl = (link: RegistryResultUrl): string => (typeof link === "string" ? link : link.url);

export const linkUrls = (entry: { results_urls?: RegistryResultUrl[] }): string[] =>
  (entry.results_urls ?? []).map(linkUrl);

export type RegistrySourceCodeUri = string | { location: string; url: string; sha256?: string };

export const sourceCodeUriUrl = (link: RegistrySourceCodeUri): string => (typeof link === "string" ? link : link.url);

export const sourceCodeUriUrls = (entry: { verified_source_code_uris?: RegistrySourceCodeUri[] }): string[] =>
  (entry.verified_source_code_uris ?? []).map(sourceCodeUriUrl);

export interface RegistryVerification {
  verifier: { url?: string; name?: string; logo_url?: string };
  status: RegistryStatus;
  recipe_source?: "on_chain_metadata" | "submitted";
  image_trust_level?: "sdf_trusted" | "upstream_pinned" | "publicly_auditable" | "arbitrary";
  out_of_band?: boolean;
  bldimg?: string;
  bldarg?: string[];
  bldopt?: string[];
  source_repo?: string;
  source_rev?: string;
  tarball_url?: string;
  tarball_sha256?: string;
  rebuilt_hash?: string;
  processed_at?: string;
  results_urls?: RegistryResultUrl[];
  source_sha256?: string;
  source_uri?: string;
  verified_source_code_uris?: RegistrySourceCodeUri[];
  source_visibility?: "public" | "private" | "unavailable";
}

export interface AggregatedWasmStatus {
  schema?: string;
  schema_version: string;
  wasm_hash: string;
  updated_at: string;
  source_code_verifications: (RegistryVerification & { retrieved_at?: string })[];
  unavailable_verifiers: {
    url: string;
    name?: string;
    reason: "fetch_failed" | "invalid_response" | "timeout" | "refused";
    error?: string;
  }[];
  agreement:
    | "single"
    | "unanimous_verified"
    | "unanimous_mismatched"
    | "disputed"
    | "unverified_only"
    | "no_data";
}

export interface BulkLoadPage {
  schema?: string;
  schema_version: string;
  order: "asc" | "desc";
  cursor: string | null;
  records: { wasm_hash: string; updated_at: string }[];
}

export interface VerificationArtifact {
  schema: "stellar-verification-artifact-v1";
  verifier: { id: string; policy_id: string };
  provenance: {
    recipe_source: "on_chain_metadata" | "submitted";
    /** `cli_managed` still appears in published results; do not narrow. */
    build_isolation: "network_isolated" | "cli_managed";
  };
  trust: { sep55_attestation_present: boolean };
  source?: {
    source_sha256: string;
    is_public: boolean;
    source_file_name?: string;
    source_uri?: string;
    chain_source_sha256?: string;
  };
  result: VerificationResultSummary;
  build_recipe?: Record<string, unknown>;
}

export interface VerifierManifest {
  schema: "stellar-verifier-manifest-v1";
  id: string;
  display_name: string;
  url: string;
  policy_url: string;
  updated_at: string;
}

export interface VerifierPolicy {
  schema: "stellar-verifier-policy-v1";
  id: string;
  build_images: {
    accepted_trust_levels: string[];
    digest_pinned_only: boolean;
    tag_only_allowed: boolean;
    arbitrary_user_images_allowed: boolean;
  };
  source_modes: string[];
  private_source: { requires_tarball_sha256_match: boolean; publish_source_bytes: boolean };
  retention: { source_retained_after_verification: boolean; result_artifacts_retained: boolean };
}

export interface TrustedVerifiersList {
  schema: "stellar-trusted-verifiers-list" | "stellar-trusted-verifiers-list-v1";
  schema_version?: string;
  verifiers: {
    id: string;
    display_name: string;
    url: string;
    manifest_url: string;
    trust_tier?: string;
    status: "active" | "paused" | "disabled";
    bulk_load_url: string;
    added_at?: string;
  }[];
  updated_at: string;
}
