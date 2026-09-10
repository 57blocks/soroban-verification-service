import type {
  BuildLogUnavailableResponse,
  PreflightResponse,
  SubmitIncompleteResponse,
  SubmitQueuedResponse,
  SubmitTargetDtoNetwork,
} from "@scvs/verify-api-client";

// The console's own view model. These are deliberately looser than the generated API client's types: one
// response object is rendered across many statuses, and the UI reads whichever fields apply to the status it
// got back.

export type TargetType = "contract_id" | "wasm_hash";

// Preflight's answer, as the console needs it.
export type UnsupportedReason =
  | "unreleased_cli"
  | "undated_nightly"
  | "missing_toolchain_pair";

export type ImagePolicyReason = "image_not_digest_pinned" | "image_not_sdf_trusted";

/** `label` is not derived from the arm it came from — see `utils/preflight.util.ts`. */
export type PreflightVerdict =
  | { gate: "ready"; kind: "chain_named" | "compose" }
  | { gate: "blocked"; label: "unsupported"; reason: UnsupportedReason | ImagePolicyReason }
  | { gate: "blocked"; label: "policy_rejected"; reason: ImagePolicyReason; detail: string }
  // An answer this bundle does not recognise — a vocabulary added server-side since it shipped.
  | { gate: "blocked"; label: "unrecognized" };

/** The published report artifact, as the console shows it. */
export type PublishedArtifactState =
  | { phase: "loading" }
  | {
      phase: "published";
      status: string | null;
      source: ArtifactSourceFacts;
      recipe: ArtifactRecipeFacts;
    }
  // No `artifact_url` on the job: a dry run writes nothing to the result root by design, and a publication
  // still in flight has not written one yet.
  | { phase: "not_published" }
  | { phase: "unreadable"; error: string };

export type ArtifactSourceFacts = {
  isPublic: boolean | null;
  sourceSha256: string | null;
  fileName: string | null;
  /** Where the archive came from — the submitted URI, which is not the published copy's URL. */
  sourceUri: string | null;
};

/** The parts of the published report the job page reads, beyond the verdict and the source. */
export type ArtifactRecipeFacts = {
  /** `on_chain_metadata` when the recipe reproduces the contract's own, `submitted` otherwise. */
  recipeSource: "on_chain_metadata" | "submitted" | null;
  buildIsolation: string | null;
  /** The `(cliver, rsver)` pair, read from the deployed Wasm's `contractmetav0` and nowhere else. */
  pair: { cliver: string | null; rsver: string | null } | null;
  environment: {
    kind: string | null;
    trustLevel: string | null;
    templateVersion: string | null;
    imageDigest: string | null;
    recipeSha256: string | null;
  } | null;
  /** One entry per pinned component of a composed environment, in the recipe's own order. */
  components: { kind: string; source: string | null; sha256: string | null }[];
  buildOptions: string[];
  metadataReplay: string[];
};

/** What the build-log pane has to render. */
export type BuildLogState =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "log"; text: string }
  | { phase: "empty" }
  | { phase: "unavailable"; body: BuildLogUnavailableResponse }
  /** This browser holds no token for this job — the shared-link case, and the intended one. */
  | { phase: "needs-token" }
  /** The raw log passed its retention period and was deleted. The diagnostic summary is unaffected. */
  | { phase: "expired" }
  | { phase: "unreadable" };

/**
 * A `bldopt` entry the console will not submit. Always labelled `policy_rejected` in the UI, never
 * `unsupported`: a disallowed option is not something that becomes allowed later.
 */
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

/**
 * How the verifier gets the source bytes — and *only* that. Visibility is `VerifyFormValues.is_public`,
 * declared separately on both modes.
 */
export type SourceAccessMode = "public_uri" | "upload_archive";

export type VerifyMode = "submit" | "job";

export type ResultTone = "success" | "warning" | "danger";

/**
 * Everything the console can display, across three vocabularies that meet only here: its own two UI states, the
 * two submission statuses `POST /api/verification/v1/verifications` can answer with (RC7), and the job wire
 * statuses that arrive later over SSE.
 */
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

/** Minimal evidence needed for reproducible verification. */
export type VerifyFormValues = {
  // The wire's own enum, not a console literal: it was pinned to `"testnet"` while the picker offered mainnet
  // as "Soon", so widening it here is what opens the network the API already served.
  network: SubmitTargetDtoNetwork;
  targetType: TargetType;
  contractId?: string;
  wasmHash?: string;
  bldarg?: string; // space-separated leading args, split into array on submit; defaults to "contract build"
  bldopt?: string; // space-separated flags, split into array on submit
  source_sha256?: string;
  source_uri?: string;
  /** The submitter's public declaration, sent as `manifest.is_public`. */
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

/** The submit response, taken from the generated client rather than restated. */
export type SubmitAccepted = SubmitQueuedResponse | SubmitIncompleteResponse;

/** What arrives on the SSE stream. */
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
  /** `jobs.completed_at` — what the timing card measures to; see `use-job-timing`. */
  completed_at?: string;
};

/**
 * A failure the console itself is reporting: a submission the verifier refused, a request that never got an
 * answer, or a bundle built without an API base.
 */
export type ConsoleFailure = {
  code: string;
  detail: string;
  job_id?: string;
};

/** What the console is displaying, discriminated by **which producer wrote it**. */
export type ConsoleState =
  | { phase: "idle" }
  | { phase: "submitting" }
  /** `POST /api/verification/v1/verifications` answered. */
  | { phase: "accepted"; response: SubmitAccepted }
  /** A job being followed — restored from the route, or pushed over SSE. */
  | { phase: "job"; state: SubmissionState; response: JobResponse }
  | { phase: "failed"; failure: ConsoleFailure };

/** Everything `StatusBanner` renders, resolved once by the hook. */
export type BannerView = {
  detail?: string;
  /** The mono `reason:` line — the verifier's machine code, or a console-local one. */
  code?: string;
  jobId?: string;
  target?: VerificationTarget;
};

export type RecentJob = {
  job_id: string;
  status: SubmissionState | "running";
  target?: VerificationTarget;
  detail?: string;
  // Time the verification job was created/submitted.
  created_at: string;
  // Time we last refreshed the local cache entry (informational only).
  updated_at: string;
  /** The `updated_at` carried by the **first** terminal event this browser saw for the job. */
  finished_at?: string;
};

/** How long this job has been running, or took. */
export type JobTiming = {
  startedMs: number;
  /** The job's last recorded change. Absent when the event that settled it carried no timestamps. */
  updatedMs?: number;
  elapsedMs: number;
  isRunning: boolean;
  /** True only when the finish instant came from the verifier's own record. */
  finishIsExact?: boolean;
};

/** A source archive the user picked locally, hashed in the browser before upload. */
export type SourceArchiveInfo = {
  name: string;
  size: number;
  sha256: string;
  file?: File;
};
