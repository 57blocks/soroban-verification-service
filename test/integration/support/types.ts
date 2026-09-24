/** Wire shapes, restated. */

/** `packages/core/src/enums.ts` — the *job* vocabulary. Note `mismatch`, not `mismatched`. */
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

/** `packages/core/src/registry.ts` — the *published* vocabulary (SO1). */
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

/** The submission body. */
export interface SubmittedManifest {
  schema: "stellar-submitted-source-verification-manifest-v1";
  bldimg?: string;
  /** Order is significant; absent normalises to `["contract", "build"]` (K4). */
  bldarg?: string[];
  /** One complete flag per entry, value in `=` form (SO5). */
  bldopt?: string[];
  source_sha256: string;
  source_uri?: string;
  upload_id?: string;
  /** Declared, never inferred from `upload_id`. */
  is_public?: boolean;
}

export interface SubmitBody {
  target: VerificationTarget;
  manifest?: SubmittedManifest;
  dry_run?: boolean;
}

/** 202 body. */
export interface SubmitQueued {
  status: "queued";
  job_id: string;
  target: VerificationTarget;
  /**
   * The one-time raw-build-log credential (build-log-access BL-1). Absent when this 202 attached to a job
   * that was already in flight: that job's token went to the submission that created it, and is not
   * re-issued. `support/build-log-token.ts` records it; no case should need to read it here.
   */
  build_log_token?: string;
  message?: string;
}

/** 200 body — on-chain metadata incomplete and no manifest supplied. */
export interface SubmitIncomplete {
  status: "incomplete";
  target: VerificationTarget;
  missing_fields: string[];
  message?: string;
}

/** `GET /api/verification/v1/verifications/:job_id`, and each SSE `data:` frame. */
export interface JobStatusBody {
  job_id: string;
  status: JobStatus;
  created_at: string;
  updated_at: string;
  target: VerificationTarget;
  result?: VerificationResultSummary;
  error?: string;
  progress?: { step: string; detail?: string };
  /** Present only on the final frame of a response the server ended for the client to reconnect. */
  stream_timeout?: boolean;
}

/** `packages/core/src/result.ts`. */
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
  /** The published-report pointer. */
  artifact_url?: string;
  artifact_sha256?: string;
  arweave_tx_id?: string;
  verified_at?: string;
}

/** `POST /api/verification/v1/uploads/source` — 201. */
export interface UploadSourceResponse {
  upload_id: string;
  expires_at: string;
  max_size_bytes: number;
  filename: string;
  size_bytes: number;
  /** Computed by the service over the bytes it received; the submitted manifest must match it. */
  source_sha256: string;
}

export interface RegistryStatusObject {
  /** `stellar-verification-status` — the document-type discriminator (CV1). */
  schema?: string;
  schema_version: string;
  wasm_hash: string;
  updated_at: string;
  /** `minItems: 1` — an empty array is never published; "nothing here" is a 404. */
  source_code_verifications: RegistryVerification[];
}

export type RegistryResultUrl = string | { type: string; location?: string; url: string; sha256?: string };

/** The URL of a `results_urls` entry in either form. */
export const linkUrl = (link: RegistryResultUrl): string => (typeof link === "string" ? link : link.url);

/** Every URL an entry links, in either form. */
export const linkUrls = (entry: { results_urls?: RegistryResultUrl[] }): string[] =>
  (entry.results_urls ?? []).map(linkUrl);

export type RegistrySourceCodeUri = string | { location: string; url: string; sha256?: string };

/** The URL of a `verified_source_code_uris` entry in either form. */
export const sourceCodeUriUrl = (link: RegistrySourceCodeUri): string => (typeof link === "string" ? link : link.url);

/** Every URL an entry's `verified_source_code_uris` names, in either form. */
export const sourceCodeUriUrls = (entry: { verified_source_code_uris?: RegistrySourceCodeUri[] }): string[] =>
  (entry.verified_source_code_uris ?? []).map(sourceCodeUriUrl);

export interface RegistryVerification {
  /**
   * `url` is the identity and REQUIRED by the SEP, `name` self-claimed. Both optional here
   * because this type reads pre-cutover and peer documents too; `E2E-PUB-03` asserts the requirement.
   */
  verifier: { url?: string; name?: string; logo_url?: string };
  status: RegistryStatus;
  recipe_source?: "on_chain_metadata" | "submitted";
  image_trust_level?: "sdf_trusted" | "upstream_pinned" | "publicly_auditable" | "arbitrary";
  /** The Registry API draft's boolean; a peer still on that shape may send it. */
  out_of_band?: boolean;
  bldimg?: string;
  /** SEP-58 v0.6.0: order-significant. */
  bldarg?: string[];
  bldopt?: string[];
  source_repo?: string;
  source_rev?: string;
  tarball_url?: string;
  tarball_sha256?: string;
  /** Required iff `mismatched` (SO2). */
  rebuilt_hash?: string;
  /** Required iff not `unverified` (SO3). */
  processed_at?: string;
  results_urls?: RegistryResultUrl[];
  /**
   * SEP-58 v0.5.0's source-identification vocabulary: `source_sha256` is required and `source_uri` optional
   * with an open-ended scheme.
   */
  source_sha256?: string;
  source_uri?: string;
  verified_source_code_uris?: RegistrySourceCodeUri[];
  source_visibility?: "public" | "private" | "unavailable";
}

/** `packages/core/src/aggregate.ts`. */
export interface AggregatedWasmStatus {
  /** `stellar-verification-aggregate` — required by the document (CV1). */
  schema?: string;
  schema_version: string;
  wasm_hash: string;
  updated_at: string;
  source_code_verifications: (RegistryVerification & { retrieved_at?: string })[];
  /** Always present; an empty array when every configured verifier was reachable. */
  unavailable_verifiers: {
    /** The verifier's result root — the identity, exactly as on a contributing entry. */
    url: string;
    /** Self-claimed and optional, like every other `verifier.name`. */
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
  /** `stellar-verification-page` — required by the document (TRD §5.7). */
  schema?: string;
  schema_version: string;
  order: "asc" | "desc";
  cursor: string | null;
  records: { wasm_hash: string; updated_at: string }[];
}

/** `packages/storage-layout/src/shapes.ts` — `reports/{sha256}.json`. */
export interface VerificationArtifact {
  schema: "stellar-verification-artifact-v1";
  verifier: { id: string; policy_id: string };
  provenance: {
    recipe_source: "on_chain_metadata" | "submitted";
    /**
     * A rebuild reports `network_isolated`. `cli_managed` stays in the union because a published result may
     * carry it; narrowing this to one value would break reading those results.
     */
    build_isolation: "network_isolated" | "cli_managed";
  };
  trust: { sep55_attestation_present: boolean };
  /** Present only when `is_public` was true. */
  source?: {
    source_sha256: string;
    is_public: boolean;
    source_file_name?: string;
    /** Present when the submitter declared a `source_uri`, regardless of `is_public`. */
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
  // No `public_key`/`previous_public_keys`: nothing is signed and AU3–AU7 are withdrawn.
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
