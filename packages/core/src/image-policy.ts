import { BLDIMG_PATTERN } from "./registry.js";

// Case-insensitive, so an upper-case digest is refused as untrusted rather than malformed.
const DIGEST_PINNED_IMAGE_RE = new RegExp(BLDIMG_PATTERN.source, "i");

const STELLAR_CLI_IMAGE_RE = /^docker\.io\/stellar\/stellar-cli@sha256:[0-9a-f]{64}$/i;

// `sha256:<64 lowercase hex>`; covers official images and composed environments alike.
export const DENIED_IMAGE_DIGESTS: readonly string[] = [];

export function isDeniedImageDigest(digest: string, denied: readonly string[] = DENIED_IMAGE_DIGESTS): boolean {
  return denied.includes(digest.toLowerCase());
}

export type ImagePolicyResult =
  | {
      ok: true;
      image: string;
      trust_level: "official_trusted";
      evidence: {
        checked: "digest_pinned_stellar_cli_image";
        reference: string;
      };
    }
  | {
      ok: false;
      reason: "image_not_digest_pinned" | "image_not_official_trusted";
      detail: string;
    };

export function imagePolicyErrorCode(
  reason: Extract<ImagePolicyResult, { ok: false }>["reason"],
): "unsupported" | "policy_rejected" {
  return reason === "image_not_official_trusted" ? "unsupported" : "policy_rejected";
}

export function evaluateBuildImage(
  image: unknown,
  denied: readonly string[] = DENIED_IMAGE_DIGESTS,
): ImagePolicyResult {
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
      reason: "image_not_official_trusted",
      detail:
        "M1 only accepts docker.io/stellar/stellar-cli digest-pinned images. Later policy adapters can verify SLSA/Sigstore/SBOM evidence from the official publish pipeline.",
    };
  }

  if (isDeniedImageDigest(image.slice(image.indexOf("@") + 1), denied)) {
    return {
      ok: false,
      reason: "image_not_official_trusted",
      detail: "This verifier has withdrawn trust from this image digest.",
    };
  }

  return {
    ok: true,
    image,
    trust_level: "official_trusted",
    evidence: {
      checked: "digest_pinned_stellar_cli_image",
      reference:
        "Official PR stellar/stellar-cli-docker#3 publishes immutable digest-addressed Stellar CLI images.",
    },
  };
}
