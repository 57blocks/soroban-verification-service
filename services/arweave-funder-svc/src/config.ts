import { createEnvValidator } from "@scvs/core";
import { IsIn, IsNotEmpty, IsNumberString, IsOptional, IsString, IsUrl, Matches, ValidateBy } from "class-validator";
import { arweaveNetwork, TURBO_ENDPOINTS, type TurboEndpoints } from "@scvs/config";
import type { FunderSettings } from "./funder.js";
import type { FunderToken } from "./adapters.js";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const KEY_ARN = /^arn:aws[a-z-]*:kms:[a-z0-9-]+:\d{12}:key\/[0-9a-f-]+$/;
const WEI = /^[1-9]\d*$/;
const WINC = WEI;
const tokens = ["ethereum", "base-eth"] as const;

const positiveWei = (name: string) => Matches(WEI, { message: `${name} must be a positive integer number of wei` });
const positiveWinc = (name: string) => Matches(WINC, { message: `${name} must be a positive integer number of winc` });

export class ArweaveFunderEnvDto {
  @IsOptional()
  @IsIn(["production", "development", "test"], { message: "NODE_ENV must be one of: production, development, test" })
  NODE_ENV?: string;

  @IsOptional() @IsNumberString()
  PORT?: string;

  @IsOptional() @IsString()
  AWS_REGION?: string;

  @IsIn(["devnet", "mainnet"], { message: "SCVS_ARWEAVE_NETWORK must be devnet or mainnet" })
  SCVS_ARWEAVE_NETWORK!: string;

  @IsIn(tokens, { message: `SCVS_ARWEAVE_TOKEN must be one of: ${tokens.join(", ")}` })
  SCVS_ARWEAVE_TOKEN!: string;

  @Matches(KEY_ARN, { message: "SCVS_FUNDER_KMS_KEY_ID must be a KMS key ARN (not an alias: an alias can be repointed)" })
  SCVS_FUNDER_KMS_KEY_ID!: string;

  @Matches(ADDRESS, { message: "SCVS_FUNDER_APPROVED_ADDRESS must be the upload key's 0x-prefixed address" })
  SCVS_FUNDER_APPROVED_ADDRESS!: string;

  @IsUrl({ require_tld: false, protocols: ["https", "http"] }, { message: "SCVS_FUNDER_RPC_URL must be a URL" })
  SCVS_FUNDER_RPC_URL!: string;

  @Matches(/^[1-9]\d*$/, { message: "SCVS_FUNDER_CHAIN_ID must be a positive integer" })
  SCVS_FUNDER_CHAIN_ID!: string;

  @Matches(ADDRESS, { message: "SCVS_FUNDER_DEPOSIT_ADDRESS must be Turbo's 0x-prefixed deposit address for this token and network" })
  SCVS_FUNDER_DEPOSIT_ADDRESS!: string;

  @IsNotEmpty({ message: "SCVS_FUNDER_STATE_BUCKET is required" })
  SCVS_FUNDER_STATE_BUCKET!: string;

  @IsOptional() @IsString()
  SCVS_FUNDER_STATE_KEY?: string;

  @IsOptional() @Matches(/^[1-9]\d*$/, { message: "SCVS_FUNDER_INTERVAL_MS must be a positive integer" })
  SCVS_FUNDER_INTERVAL_MS?: string;

  @IsOptional() @Matches(/^\d+$/, { message: "SCVS_FUNDER_MAX_REPLACEMENTS must be a non-negative integer" })
  SCVS_FUNDER_MAX_REPLACEMENTS?: string;

  @positiveWinc("SCVS_FUNDER_CREDITS_LOW_WINC")
  SCVS_FUNDER_CREDITS_LOW_WINC!: string;

  @positiveWei("SCVS_FUNDER_TOPUP_WEI")
  SCVS_FUNDER_TOPUP_WEI!: string;

  @positiveWei("SCVS_FUNDER_DAILY_TOPUP_CAP_WEI")
  @ValidateBy({
    name: "capCoversOneTopUp",
    validator: {
      validate: (value, args) => {
        const env = args?.object as ArweaveFunderEnvDto;
        return !WEI.test(String(value)) || !WEI.test(String(env.SCVS_FUNDER_TOPUP_WEI)) || BigInt(value) >= BigInt(env.SCVS_FUNDER_TOPUP_WEI);
      },
      defaultMessage: () => "SCVS_FUNDER_DAILY_TOPUP_CAP_WEI must be at least SCVS_FUNDER_TOPUP_WEI",
    },
  })
  SCVS_FUNDER_DAILY_TOPUP_CAP_WEI!: string;

  @positiveWei("SCVS_FUNDER_MAX_FEE_PER_GAS_WEI")
  SCVS_FUNDER_MAX_FEE_PER_GAS_WEI!: string;

  @positiveWinc("SCVS_FUNDER_SHARE_WINC")
  SCVS_FUNDER_SHARE_WINC!: string;

  @IsOptional() @Matches(/^[1-9]\d*$/, { message: "SCVS_FUNDER_SHARE_TTL_SECONDS must be a positive integer" })
  SCVS_FUNDER_SHARE_TTL_SECONDS?: string;

  @IsOptional()
  @positiveWinc("SCVS_FUNDER_SHARE_WINDOW_CAP_WINC")
  @ValidateBy({
    name: "windowCoversOneShare",
    validator: {
      validate: (value, args) => {
        const env = args?.object as ArweaveFunderEnvDto;
        return !WINC.test(String(value)) || !WINC.test(String(env.SCVS_FUNDER_SHARE_WINC)) || BigInt(value) >= BigInt(env.SCVS_FUNDER_SHARE_WINC);
      },
      defaultMessage: () => "SCVS_FUNDER_SHARE_WINDOW_CAP_WINC must be at least SCVS_FUNDER_SHARE_WINC",
    },
  })
  SCVS_FUNDER_SHARE_WINDOW_CAP_WINC?: string;
}

export const validateFunderEnv = createEnvValidator(ArweaveFunderEnvDto, "arweave-funder-svc");

export type FunderConfig = {
  port: number;
  awsRegion?: string;
  network: "devnet" | "mainnet";
  turbo: TurboEndpoints;
  token: FunderToken;
  kmsKeyId: string;
  rpcUrl: string;
  stateBucket: string;
  stateKey: string;
  intervalMs: number;
  settings: Omit<FunderSettings, "holder">;
};

const DEFAULT_PORT = 5003;
const DEFAULT_INTERVAL_MS = 5 * 60_000;
const DEFAULT_SHARE_TTL_SECONDS = 7 * 86_400;
const RENEW_BEFORE_SECONDS = 86_400;
const STUCK_AFTER_SECONDS = 15 * 60;
const DEFAULT_MAX_REPLACEMENTS = 5;
// Base mainnet and Base Sepolia: OP-stack chains, whose GasPriceOracle predeploy quotes the L1 data fee.
const L1_DATA_FEE_CHAINS = new Set([8453, 84532]);
// A plain ETH transfer is 21000; a Turbo deposit address is an externally owned account, so anything far above is not one.
const MAX_GAS_LIMIT = 60_000n;

export function loadFunderConfig(env: NodeJS.ProcessEnv = process.env): FunderConfig {
  validateFunderEnv(env as Record<string, unknown>);
  const intervalMs = Number(env.SCVS_FUNDER_INTERVAL_MS || DEFAULT_INTERVAL_MS);
  const shareWinc = BigInt(env.SCVS_FUNDER_SHARE_WINC!);
  const network = arweaveNetwork(env.SCVS_ARWEAVE_NETWORK);
  return {
    port: Number(env.PORT || DEFAULT_PORT),
    awsRegion: env.AWS_REGION || undefined,
    network,
    turbo: TURBO_ENDPOINTS[network],
    token: env.SCVS_ARWEAVE_TOKEN === "base-eth" ? "base-eth" : "ethereum",
    kmsKeyId: env.SCVS_FUNDER_KMS_KEY_ID!,
    rpcUrl: env.SCVS_FUNDER_RPC_URL!,
    stateBucket: env.SCVS_FUNDER_STATE_BUCKET!,
    stateKey: env.SCVS_FUNDER_STATE_KEY || "arweave-funder/state.json",
    intervalMs,
    settings: {
      chainId: Number(env.SCVS_FUNDER_CHAIN_ID),
      depositAddress: env.SCVS_FUNDER_DEPOSIT_ADDRESS!.toLowerCase(),
      approvedAddress: env.SCVS_FUNDER_APPROVED_ADDRESS!.toLowerCase(),
      creditsLowWinc: BigInt(env.SCVS_FUNDER_CREDITS_LOW_WINC!),
      topUpWei: BigInt(env.SCVS_FUNDER_TOPUP_WEI!),
      dailyTopUpCapWei: BigInt(env.SCVS_FUNDER_DAILY_TOPUP_CAP_WEI!),
      maxFeePerGasWei: BigInt(env.SCVS_FUNDER_MAX_FEE_PER_GAS_WEI!),
      maxGasLimit: MAX_GAS_LIMIT,
      stuckAfterSeconds: STUCK_AFTER_SECONDS,
      maxReplacements: env.SCVS_FUNDER_MAX_REPLACEMENTS ? Number(env.SCVS_FUNDER_MAX_REPLACEMENTS) : DEFAULT_MAX_REPLACEMENTS,
      l1DataFee: L1_DATA_FEE_CHAINS.has(Number(env.SCVS_FUNDER_CHAIN_ID)),
      shareWinc,
      shareTtlSeconds: Number(env.SCVS_FUNDER_SHARE_TTL_SECONDS || DEFAULT_SHARE_TTL_SECONDS),
      shareRenewBeforeSeconds: RENEW_BEFORE_SECONDS,
      // One early renewal per window by default: a working uploader never needs more, a stolen key gets twice the share at most.
      shareWindowCapWinc: env.SCVS_FUNDER_SHARE_WINDOW_CAP_WINC ? BigInt(env.SCVS_FUNDER_SHARE_WINDOW_CAP_WINC) : shareWinc * 2n,
      leaseSeconds: Math.ceil((intervalMs * 3) / 1000),
    },
  };
}
