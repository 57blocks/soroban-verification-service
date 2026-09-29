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
      "official-trusted-public-and-private-upload-v1",
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
    acceptedTrustLevels: parseCsv(process.env.SCVS_POLICY_ACCEPTED_TRUST_LEVELS, ["official_trusted"]),
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
  mode: "disabled" | "dry-run" | "irys";
  network: "mainnet" | "devnet";
  /** The Ethereum L1 RPC the wallet signs through, not an Irys endpoint. */
  rpcUrl?: string;
  privateKey?: string;
  gatewayUrl: string;
  /** Whether public mainnet source is eligible for Arweave archival; independent of `mode`. */
  sourceArchiveEnabled: boolean;
};

const DEVNET_DEFAULT_RPC_URL = "https://ethereum-sepolia-rpc.publicnode.com";
const DEFAULT_ARWEAVE_GATEWAY_URL = "https://gateway.irys.xyz";

export function getArweaveConfig(): ArweaveConfig {
  const rawMode = (process.env.SCVS_ARWEAVE_MODE || "disabled").toLowerCase();
  const mode: ArweaveConfig["mode"] =
    rawMode === "dry-run" || rawMode === "dry_run"
      ? "dry-run"
      : rawMode === "irys"
        ? "irys"
        : "disabled";
  const network: ArweaveConfig["network"] =
    (process.env.SCVS_ARWEAVE_NETWORK || "devnet").toLowerCase() === "mainnet" ? "mainnet" : "devnet";
  return {
    mode,
    network,
    rpcUrl: process.env.SCVS_ARWEAVE_RPC_URL || (network === "devnet" ? DEVNET_DEFAULT_RPC_URL : undefined),
    privateKey: process.env.SCVS_ARWEAVE_WALLET_PRIVATE_KEY,
    gatewayUrl: (process.env.SCVS_ARWEAVE_GATEWAY_URL || DEFAULT_ARWEAVE_GATEWAY_URL).replace(/\/+$/, ""),
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
