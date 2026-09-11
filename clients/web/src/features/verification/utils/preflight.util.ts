import type { PreflightResponseBuildEnvironment } from "@scvs/verify-api-client";
import type { ImagePolicyReason, PreflightVerdict } from "../types";

/** Which label an image-policy rejection carries. */
const imagePolicyLabel = (reason: ImagePolicyReason): "unsupported" | "policy_rejected" =>
  reason === "image_not_sdf_trusted" ? "unsupported" : "policy_rejected";

/** Preflight's per-contract answer, reduced to "may this be submitted, and if not, why". */
export const readVerdict = (buildEnvironment: unknown): PreflightVerdict | null => {
  if (typeof buildEnvironment !== "object" || buildEnvironment === null) return null;
  const environment = buildEnvironment as Partial<PreflightResponseBuildEnvironment> & {
    reason?: string;
    detail?: string;
  };

  switch (environment.kind) {
    case "chain_named":
    case "compose":
      return { gate: "ready", kind: environment.kind };

    case "unsupported":
      return isUnsupportedReason(environment.reason)
        ? { gate: "blocked", label: "unsupported", reason: environment.reason }
        : null;

    case "chain_named_policy_rejected": {
      if (!isImagePolicyReason(environment.reason)) return null;
      const label = imagePolicyLabel(environment.reason);
      return label === "unsupported"
        ? { gate: "blocked", label, reason: environment.reason }
        : { gate: "blocked", label, reason: environment.reason, detail: environment.detail ?? "" };
    }

    default:
      return null;
  }
};

const unsupportedReasons = ["unreleased_cli", "undated_nightly", "missing_toolchain_pair"] as const;
const imagePolicyReasons = ["image_not_digest_pinned", "image_not_sdf_trusted"] as const;

const isUnsupportedReason = (value: unknown): value is (typeof unsupportedReasons)[number] =>
  typeof value === "string" && (unsupportedReasons as readonly string[]).includes(value);

const isImagePolicyReason = (value: unknown): value is ImagePolicyReason =>
  typeof value === "string" && (imagePolicyReasons as readonly string[]).includes(value);
