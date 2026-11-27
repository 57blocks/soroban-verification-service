import type { Network } from "@scvs/core";

export type { Network };

export {
  envFilePaths,
  findWorkspaceRoot,
  rootEnvFilePath,
} from "./workspace-root.js";

export * from "./env.dto.js";

export * from "./config-contract.js";
export {
  ENV_CONTRACT,
  MANIFEST_VERSION,
  type Observability,
  type VariableDescriptor,
} from "./env-contract.generated.js";

export type VerifierIdentity = {
  id: string;
  displayName: string;
  policyId: string;
};

export function getVerifierIdentity(): VerifierIdentity {
  return {
    id: process.env.SCVS_VERIFIER_ID || "local-verifier",
    displayName:
      process.env.SCVS_VERIFIER_DISPLAY_NAME || "Local Soroban Verifier",
    policyId:
      process.env.SCVS_VERIFIER_POLICY_ID ||
      "official-trusted-public-and-private-upload-v2",
  };
}

export type VerifierPolicyConfig = {
  acceptedTrustLevels: string[];
  digestPinnedOnly: boolean;
  tagOnlyAllowed: boolean;
  arbitraryUserImagesAllowed: boolean;
  requiresTarballSha256Match: boolean;
  resultArtifactsRetained: boolean;
};

function boolEnv(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value === undefined) return fallback;
  return value.toLowerCase() === "true";
}

function parseCsv(value: string | undefined, fallback: string[]): string[] {
  if (!value) return fallback;
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/** Reads each `SCVS_POLICY_*` literally at its call site, which check-env-manifest.mjs's static scan requires. */
export function getVerifierPolicyConfig(): VerifierPolicyConfig {
  return {
    acceptedTrustLevels: parseCsv(process.env.SCVS_POLICY_ACCEPTED_TRUST_LEVELS, ["official_trusted", "upstream_pinned"]),
    digestPinnedOnly: boolEnv("SCVS_POLICY_DIGEST_PINNED_ONLY", true),
    tagOnlyAllowed: boolEnv("SCVS_POLICY_TAG_ONLY_ALLOWED", false),
    arbitraryUserImagesAllowed: boolEnv("SCVS_POLICY_ARBITRARY_IMAGES_ALLOWED", false),
    requiresTarballSha256Match: boolEnv("SCVS_POLICY_REQUIRE_TARBALL_SHA256", true),
    resultArtifactsRetained: boolEnv("SCVS_POLICY_RETAIN_ARTIFACTS", true),
  };
}

export type StagingStorageConfig = {
  bucket: string;
  region: string;
};

export function getStagingStorageConfig(): StagingStorageConfig {
  return {
    bucket: requireEnv("SCVS_STORAGE_BUCKET"),
    region: process.env.AWS_REGION || "us-east-1",
  };
}

export type ArweaveConfig = {
  mode: "disabled" | "dry-run" | "turbo";
  network: ArweaveNetwork;
  /** The Turbo token credits are bought in; both are Ethereum-signed, so it decides only how an address is billed. */
  token: ArweaveToken;
  turbo: TurboEndpoints;
  signer: "kms" | "private-key";
  /** Read only when `signer` is `kms`. */
  kmsKeyId?: string;
  /** Read only when `signer` is `private-key`. */
  privateKey?: string;
  /** Lowercased address whose Turbo credits pay, through the credits it shared with the signer; unset means the signer pays. */
  paidBy?: string;
  gatewayUrl: string;
  /** Arweave blocks an archived item must be under before it is linked; 0 links on upload (devnet never reaches Arweave). */
  confirmations: number;
  /** Whether public mainnet source is eligible for Arweave archival; independent of `mode`. */
  sourceArchiveEnabled: boolean;
};

export const arweaveTokens = ["ethereum", "base-eth"] as const;
export type ArweaveToken = (typeof arweaveTokens)[number];
export type ArweaveNetwork = "mainnet" | "devnet";

export type TurboEndpoints = { uploadUrl: string; paymentUrl: string };

// devnet is the ar.io sandbox: testnet tokens only, items purged after a few days, never posted to Arweave.
export const TURBO_ENDPOINTS: Record<ArweaveNetwork, TurboEndpoints> = {
  mainnet: { uploadUrl: "https://upload.ardrive.io", paymentUrl: "https://payment.ardrive.io" },
  devnet: { uploadUrl: "https://upload.services.ar-io.dev", paymentUrl: "https://payment.services.ar-io.dev" },
};

const DEFAULT_ARWEAVE_CONFIRMATIONS = 15;

const DEFAULT_ARWEAVE_GATEWAY_URLS: Record<ArweaveNetwork, string> = {
  mainnet: "https://arweave.net",
  devnet: "https://ar-io.dev",
};

export function arweaveNetwork(value: string | undefined): ArweaveNetwork {
  return (value || "devnet").toLowerCase() === "mainnet" ? "mainnet" : "devnet";
}

export function getArweaveConfig(): ArweaveConfig {
  const rawMode = (process.env.SCVS_ARWEAVE_MODE || "disabled").toLowerCase();
  const mode: ArweaveConfig["mode"] =
    rawMode === "dry-run" || rawMode === "dry_run"
      ? "dry-run"
      : rawMode === "turbo"
        ? "turbo"
        : "disabled";
  const network = arweaveNetwork(process.env.SCVS_ARWEAVE_NETWORK);
  const token: ArweaveToken = (process.env.SCVS_ARWEAVE_TOKEN || "ethereum").toLowerCase() === "base-eth" ? "base-eth" : "ethereum";
  return {
    mode,
    network,
    token,
    turbo: TURBO_ENDPOINTS[network],
    signer: (process.env.SCVS_ARWEAVE_SIGNER || "private-key").toLowerCase() === "kms" ? "kms" : "private-key",
    kmsKeyId: process.env.SCVS_ARWEAVE_KMS_KEY_ID || undefined,
    privateKey: process.env.SCVS_ARWEAVE_WALLET_PRIVATE_KEY,
    paidBy: process.env.SCVS_ARWEAVE_PAID_BY?.toLowerCase() || undefined,
    gatewayUrl: (process.env.SCVS_ARWEAVE_GATEWAY_URL || DEFAULT_ARWEAVE_GATEWAY_URLS[network]).replace(/\/+$/, ""),
    confirmations: mode === "turbo" && network === "mainnet" ? Number(process.env.SCVS_ARWEAVE_CONFIRMATIONS || DEFAULT_ARWEAVE_CONFIRMATIONS) : 0,
    sourceArchiveEnabled: boolEnv("SCVS_SOURCE_ARCHIVE_ENABLED", false),
  };
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value)
    throw new Error(`${name} is required — see the repository root .env.example.`);
  return value;
}
export * from "./drain.module.js";
