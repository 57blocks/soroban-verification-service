import { SharedEnvDto } from "@scvs/config";
import { IsIn, IsNumberString, IsOptional, IsUrl, Matches } from "class-validator";

/** This service's environment contract, validated once at boot by `ConfigModule.forRoot({ validate })`. */
export class QuerySvcEnvDto extends SharedEnvDto {
  // Positive, not just numeric: the SDK refuses a non-positive timeout, so a `0` would boot clean and then fail
  // every query.
  @IsOptional()
  @Matches(/^[1-9]\d*$/, { message: "SCVS_QUERY_TIMEOUT_MS must be a positive number of milliseconds" })
  SCVS_QUERY_TIMEOUT_MS?: string;

  @IsOptional() @IsNumberString({}, { message: "SCVS_QUERY_CACHE_TTL_MS must be a number" })
  SCVS_QUERY_CACHE_TTL_MS?: string;

  @IsOptional()
  @IsNumberString({}, { message: "SCVS_AGGREGATION_SYNC_INTERVAL_MS must be a number" })
  SCVS_AGGREGATION_SYNC_INTERVAL_MS?: string;

  // Bounded to [1, 200] in configuration.ts, not here: the bound is the Registry API's own MAX_BULK_LIMIT
  // (packages/core/src/cursor.ts), not a shape constraint a regex should encode.
  @IsOptional()
  @IsNumberString({}, { message: "SCVS_BULK_PAGE_LIMIT must be a number" })
  SCVS_BULK_PAGE_LIMIT?: string;

  @IsOptional() @IsNumberString({}, { message: "SCVS_RPC_TIMEOUT_MS must be a number" })
  SCVS_RPC_TIMEOUT_MS?: string;

  // Validated as URLs at boot: an unreachable endpoint is a runtime failure, but a malformed one is a typo
  // worth catching before the first mainnet query finds it.
  @IsOptional() @IsUrl({ require_tld: false }, { message: "STELLAR_RPC_URL_TESTNET must be a URL" })
  STELLAR_RPC_URL_TESTNET?: string;

  @IsOptional() @IsUrl({ require_tld: false }, { message: "STELLAR_RPC_URL_MAINNET must be a URL" })
  STELLAR_RPC_URL_MAINNET?: string;

  /** Exactly `"true"` or `"false"`, so a typo fails at boot instead of quietly not applying. */
  @IsOptional()
  @IsIn(["true", "false"], {
    message: 'SCVS_QUERY_ALLOW_INSECURE_RESULT_ROOTS must be exactly "true" or "false"',
  })
  SCVS_QUERY_ALLOW_INSECURE_RESULT_ROOTS?: string;

  // Defaults to on (configuration.ts). A test double that replaces `globalThis.fetch` cannot intercept the
  // pinned transport — it bypasses that global on purpose, which is what lets it see the DNS answer `checkUrl`
  // alone cannot.
  @IsOptional()
  @IsIn(["true", "false"], {
    message: 'SCVS_QUERY_PIN_DNS_RESOLUTION must be exactly "true" or "false"',
  })
  SCVS_QUERY_PIN_DNS_RESOLUTION?: string;
}
