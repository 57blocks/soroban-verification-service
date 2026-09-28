import type {
  BuildLogUnavailableResponse,
  PreflightResponse,
  SubmitIncompleteResponse,
  SubmitQueuedResponse,
  SubmitTargetDtoNetwork,
} from "@scvs/verify-api-client";

export type TargetType = "contract_id" | "wasm_hash";

export type UnsupportedReason =
  | "unreleased_cli"
  | "undated_nightly"
  | "missing_toolchain_pair";

export type ImagePolicyReason = "image_not_digest_pinned" | "image_not_sdf_trusted";

export type PreflightVerdict =
  | { gate: "ready"; kind: "chain_named" | "compose" }
  | { gate: "blocked"; label: "unsupported"; reason: UnsupportedReason | ImagePolicyReason }
  | { gate: "blocked"; label: "policy_rejected"; reason: ImagePolicyReason; detail: string }
  | { gate: "blocked"; label: "unrecognized" };

export type PublishedArtifactState =
  | { phase: "loading" }
  | {
      phase: "published";
      status: string | null;
      source: ArtifactSourceFacts;
      recipe: ArtifactRecipeFacts;
    }
  | { phase: "not_published" }
  | { phase: "unreadable"; error: string };

export type ArtifactSourceFacts = {
  isPublic: boolean | null;
  sourceSha256: string | null;
  fileName: string | null;
  sourceUri: string | null;
};

export type ArtifactRecipeFacts = {
  recipeSource: "on_chain_metadata" | "submitted" | null;
  buildIsolation: string | null;
  pair: { cliver: string | null; rsver: string | null } | null;
  environment: {
    kind: string | null;
    trustLevel: string | null;
    templateVersion: string | null;
    imageDigest: string | null;
    recipeSha256: string | null;
  } | null;
  components: { kind: string; source: string | null; sha256: string | null }[];
  buildOptions: string[];
  metadataReplay: string[];
};

export type BuildLogState =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "log"; text: string }
  | { phase: "empty" }
  | { phase: "unavailable"; body: BuildLogUnavailableResponse }
  | { phase: "needs-token" }
  | { phase: "expired" }
  | { phase: "unreadable" };

export type RejectedBuildOption = {
  option: string;
  reason: "path_escapes_source_tree" | "not_replayable" | "unparsable";
  detail: string;
};

export type PreflightState =
  | { phase: "idle" }
  | { phase: "running" }
  | { phase: "answered"; verdict: PreflightVerdict; response: PreflightResponse }
  | { phase: "failed"; error: string };

export type SourceAccessMode = "public_uri" | "upload_archive";

export type VerifyMode = "submit" | "job";

export type ResultTone = "success" | "warning" | "danger";

export type SubmissionState =
  | "idle"
  | "submitting"
  | "queued"
  | "verified"
  | "mismatch"
  | "source_unavailable"
  | "build_failed"
  | "policy_rejected"
  | "not_attempted"
  | "incomplete"
  | "error";

export type TerminalSubmissionState = Exclude<
  SubmissionState,
  "idle" | "submitting"
>;

export type VerifyFormValues = {
  network: SubmitTargetDtoNetwork;
  targetType: TargetType;
  contractId?: string;
  wasmHash?: string;
  bldarg?: string;
  bldopt?: string;
  source_sha256?: string;
  source_uri?: string;
  is_public?: boolean;
};

export type SourceUploadResponse = {
  upload_id?: string;
  source_sha256?: string;
  filename?: string;
  size_bytes?: number;
  expires_at?: string;
  error?: string;
  message?: string;
};

export type VerificationTarget = {
  network?: string;
  contract_id?: string;
  wasm_hash?: string;
};

export type SubmitAccepted = SubmitQueuedResponse | SubmitIncompleteResponse;

export type JobResponse = {
  status?: SubmissionState | "running";
  reason?: string;
  detail?: string;
  job_id?: string;
  target?: VerificationTarget;
  result?: Record<string, unknown>;
  progress?: { step?: string; detail?: string };
  created_at?: string;
  updated_at?: string;
  completed_at?: string;
};

export type ConsoleFailure = {
  code: string;
  detail: string;
  job_id?: string;
};

export type ConsoleState =
  | { phase: "idle" }
  | { phase: "submitting" }
  | { phase: "accepted"; response: SubmitAccepted }
  | { phase: "job"; state: SubmissionState; response: JobResponse }
  | { phase: "failed"; failure: ConsoleFailure };

export type BannerView = {
  detail?: string;
  code?: string;
  jobId?: string;
  target?: VerificationTarget;
};

export type RecentJob = {
  job_id: string;
  status: SubmissionState | "running";
  target?: VerificationTarget;
  detail?: string;
  created_at: string;
  updated_at: string;
  finished_at?: string;
};

export type JobTiming = {
  startedMs: number;
  updatedMs?: number;
  elapsedMs: number;
  isRunning: boolean;
  finishIsExact?: boolean;
};

export type SourceArchiveInfo = {
  name: string;
  size: number;
  sha256: string;
  file?: File;
};
