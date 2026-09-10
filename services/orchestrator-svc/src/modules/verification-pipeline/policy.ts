// Pure, no imports — cheap to duplicate per service rather than adding a shared package for a ~10-line
// function.

const DIGEST_PINNED_IMAGE_RE = /^(?:localhost(?::\d+)?|[^\s@/]*[.:][^\s@/]*)\/[^\s@]+@sha256:[0-9a-f]{64}$/i;

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
      reference: "Official PR stellar/stellar-cli-docker#3 publishes immutable digest-addressed Stellar CLI images.",
    },
  };
}
