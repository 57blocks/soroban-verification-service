import { BLDIMG_PATTERN } from "./registry.js";

/**
 * Which build images this verifier is willing to rebuild in — the security predicate, in one place.
 *
 * Two services ask it at two moments: `verification-svc` before accepting a submission, `orchestrator-svc`
 * again before dispatch. They used to hold a copy each, each with its own test coverage or none, while the
 * policy itself is under active change.
 */

// The same shape the SEP-58 `bldimg` field must have, case-insensitively. `BLDIMG_PATTERN` governs what may be
// *published* and is lower-case only; a submitter typing an upper-case digest is answered by the trust rung
// below rather than by the shape one, which is the behaviour both copies had.
const DIGEST_PINNED_IMAGE_RE = new RegExp(BLDIMG_PATTERN.source, "i");

const STELLAR_CLI_IMAGE_RE = /^docker\.io\/stellar\/stellar-cli@sha256:[0-9a-f]{64}$/i;

export type ImagePolicyResult =
  | {
      ok: true;
      image: string;
      trust_level: "sdf_trusted";
      evidence: {
        checked: "digest_pinned_stellar_cli_image";
        reference: string;
      };
    }
  | {
      ok: false;
      reason: "image_not_digest_pinned" | "image_not_sdf_trusted";
      detail: string;
    };

/**
 * Which error code a rejection answers with. The two reasons are disjoint and telling them apart is the whole
 * point: a well-formed image policy has not accepted *yet* is "come back later", while a tag-only reference is
 * "fix your submission".
 */
export function imagePolicyErrorCode(
  reason: Extract<ImagePolicyResult, { ok: false }>["reason"],
): "unsupported" | "policy_rejected" {
  return reason === "image_not_sdf_trusted" ? "unsupported" : "policy_rejected";
}

export function evaluateBuildImage(image: unknown): ImagePolicyResult {
  if (typeof image !== "string" || !DIGEST_PINNED_IMAGE_RE.test(image)) {
    return {
      ok: false,
      reason: "image_not_digest_pinned",
      detail:
        "build.image must be a fully qualified digest-pinned reference such as docker.io/stellar/stellar-cli@sha256:<64 hex chars>.",
    };
  }

  if (!STELLAR_CLI_IMAGE_RE.test(image)) {
    return {
      ok: false,
      reason: "image_not_sdf_trusted",
      detail:
        "M1 only accepts docker.io/stellar/stellar-cli digest-pinned images. Later policy adapters can verify SLSA/Sigstore/SBOM evidence from the official publish pipeline.",
    };
  }

  return {
    ok: true,
    image,
    trust_level: "sdf_trusted",
    evidence: {
      checked: "digest_pinned_stellar_cli_image",
      reference:
        "Official PR stellar/stellar-cli-docker#3 publishes immutable digest-addressed Stellar CLI images.",
    },
  };
}
