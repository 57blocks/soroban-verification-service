import type {
  ResultTone,
  TerminalSubmissionState,
  VerifyFormValues,
} from "./types";

export const submittedManifestSchema =
  "stellar-submitted-source-verification-manifest-v1";

export const defaultValues: VerifyFormValues = {
  network: "testnet",
  targetType: "contract_id",
  contractId: "",
  wasmHash: "",
  bldarg: "",
  bldopt: "",
  source_sha256: "",
  source_uri: "",
  is_public: false,
};

export const evidenceFields = ["source_sha256", "source_uri", "bldarg", "bldopt"] as const;

export const submissionAgreementCopy =
  "By submitting a contract for verification you agree to the";

export const sourceArchiveAccept =
  ".tar.gz,.tgz,.gz,.zip,application/gzip,application/zip";

export const preflightBlockedCopy: Record<string, { title: string; description: string }> = {
  unreleased_cli: {
    title: "This contract cannot be verified",
    description:
      "The deployed Wasm records a Stellar CLI version that has no released build, so there is no environment to reproduce it in. Nothing in your submission would change this.",
  },
  undated_nightly: {
    title: "This contract cannot be verified",
    description:
      "The deployed Wasm records an undated nightly Rust toolchain. A nightly with no date cannot be resolved to specific bytes, so the rebuild would not be reproducible.",
  },
  missing_toolchain_pair: {
    title: "This contract cannot be verified",
    description:
      "The deployed Wasm records no usable toolchain pair, so its build environment cannot be resolved from the chain. Verifying it is out of scope for this launch.",
  },
  image_not_official_trusted: {
    title: "This contract cannot be verified yet",
    description:
      "The build image this contract records is digest-pinned but is not one this verifier accepts yet. This is a property of the contract, not of your submission — there is nothing to correct.",
  },
  image_not_digest_pinned: {
    title: "Rejected by verification policy",
    description:
      "The build image this contract records is not a fully qualified, digest-pinned reference. A floating tag cannot pin the bytes a rebuild would use, so it will not be accepted.",
  },
  unrecognized: {
    title: "Preflight's answer could not be read",
    description:
      "This console does not recognise the answer the verifier gave for this contract, so it will not let a submission through on a guess. Reload the page; if it persists, this console build is older than the API it is talking to.",
  },
};

export const flowSteps = [
  { label: "Submit target" },
  { label: "Queue or resolve" },
  { label: "Rebuild & compare" },
];

export const fieldCopy: Record<
  string,
  { label: string; hint: string; description: string }
> = {
  source_sha256: {
    label: "Source SHA-256 (source_sha256)",
    hint: "Hash of the exact source archive bytes.",
    description:
      "Required. Provide the SHA-256 hash of the exact source archive bytes, or select the local archive below to calculate it.",
  },
  source_uri: {
    label: "Source URI (source_uri)",
    hint: "Public link to the exact source archive.",
    description:
      "Required on the Public URI path — it is the only thing that tells the verifier where the bytes are. When the source is not hosted anywhere the verifier can reach, upload the archive instead and the picker calculates the hash.",
  },
  bldarg: {
    label: "Build arguments (bldarg)",
    hint: 'Defaults to "contract build" when left blank.',
    description:
      'Optional. Leading arguments passed to the build image\'s entry point, e.g. "cargo build" for a plain Rust image.',
  },
  bldopt: {
    label: "Build options (bldopt)",
    hint: "Needed for builds that used non-default flags.",
    description:
      "Optional, but needed when the original build used non-default flags such as --locked or --features.",
  },
};

export const responseCopy: Record<
  TerminalSubmissionState,
  { title: string; description: string; tone: ResultTone }
> = {
  queued: {
    title: "Verification queued",
    description:
      "The target has enough evidence and is waiting for the rebuild result.",
    tone: "warning",
  },
  verified: {
    title: "Verification passed",
    description: "The rebuilt Wasm matched the target byte-for-byte.",
    tone: "success",
  },
  mismatch: {
    title: "Verification mismatch",
    description: "The rebuilt Wasm did not match the target bytes.",
    tone: "danger",
  },
  source_unavailable: {
    title: "Source unavailable",
    description:
      "The verifier could not fetch or read the source archive needed for the rebuild.",
    tone: "danger",
  },
  build_failed: {
    title: "Build failed",
    description: "The verifier could not rebuild the submitted source.",
    tone: "danger",
  },
  policy_rejected: {
    title: "Policy rejected",
    description:
      "This submission was rejected by verification policy. Review the detail message and adjust the inputs.",
    tone: "danger",
  },
  not_attempted: {
    title: "Verification not attempted",
    description:
      "The verifier did not attempt a rebuild for this target. See detail for the reason.",
    tone: "warning",
  },
  incomplete: {
    title: "More information needed",
    description:
      "The verifier found the target, but source or build evidence is missing.",
    tone: "warning",
  },
  error: {
    title: "Verification could not start",
    description: "Fix the input or API configuration, then try again.",
    tone: "danger",
  },
};

export const toneSurface: Record<ResultTone, string> = {
  success: "bg-success-surface",
  warning: "bg-warning-surface",
  danger: "bg-danger-surface",
};

export const toneBorder: Record<ResultTone, string> = {
  success: "border-success-fg/60",
  warning: "border-warning-fg/60",
  danger: "border-danger-fg/60",
};

export const toneText: Record<ResultTone, string> = {
  success: "text-success-fg",
  warning: "text-warning-fg",
  danger: "text-danger-fg",
};

export const toneBadge: Record<ResultTone, string> = {
  success: "bg-success-fg",
  warning: "bg-warning-fg",
  danger: "bg-danger-fg",
};

export const toneGlyph: Record<ResultTone, string> = {
  success: "✓",
  warning: "!",
  danger: "✕",
};

export const toneDot: Record<ResultTone, string> = {
  success: "bg-success-dot",
  warning: "bg-warning-dot",
  danger: "bg-danger-dot",
};
