import { SharedEnvDto } from "@scvs/config";
import { IsIn, IsNumberString, IsOptional, IsUrl, Matches } from "class-validator";

export class QuerySvcEnvDto extends SharedEnvDto {
  @IsOptional()
  @Matches(/^[1-9]\d*$/, {
    message: "SCVS_QUERY_THROTTLE_LIMIT must be a positive whole number of requests per minute",
  })
  SCVS_QUERY_THROTTLE_LIMIT?: string;

  @IsOptional()
  @Matches(/^[1-9]\d*$/, {
    message: "SCVS_QUERY_ADDRESS_THROTTLE_LIMIT must be a positive whole number of requests per minute",
  })
  SCVS_QUERY_ADDRESS_THROTTLE_LIMIT?: string;

  @IsOptional()
  @Matches(/^[1-9]\d*$/, {
    message: "SCVS_READINESS_DB_TIMEOUT_MS must be a positive number of milliseconds",
  })
  SCVS_READINESS_DB_TIMEOUT_MS?: string;

  @IsOptional()
  @Matches(/^[1-9]\d*$/, { message: "SCVS_QUERY_TIMEOUT_MS must be a positive number of milliseconds" })
  SCVS_QUERY_TIMEOUT_MS?: string;

  @IsOptional() @IsNumberString({}, { message: "SCVS_QUERY_CACHE_TTL_MS must be a number" })
  SCVS_QUERY_CACHE_TTL_MS?: string;

  @IsOptional()
  @IsNumberString({}, { message: "SCVS_AGGREGATION_SYNC_INTERVAL_MS must be a number" })
  SCVS_AGGREGATION_SYNC_INTERVAL_MS?: string;

  @IsOptional()
  @IsNumberString({}, { message: "SCVS_BULK_PAGE_LIMIT must be a number" })
  SCVS_BULK_PAGE_LIMIT?: string;

  @IsOptional() @IsNumberString({}, { message: "SCVS_RPC_TIMEOUT_MS must be a number" })
  SCVS_RPC_TIMEOUT_MS?: string;

  @IsOptional() @IsUrl({ require_tld: false }, { message: "STELLAR_RPC_URL_TESTNET must be a URL" })
  STELLAR_RPC_URL_TESTNET?: string;

  @IsOptional() @IsUrl({ require_tld: false }, { message: "STELLAR_RPC_URL_MAINNET must be a URL" })
  STELLAR_RPC_URL_MAINNET?: string;

  @IsOptional()
  @IsIn(["true", "false"], {
    message: 'SCVS_QUERY_ALLOW_INSECURE_RESULT_ROOTS must be exactly "true" or "false"',
  })
  SCVS_QUERY_ALLOW_INSECURE_RESULT_ROOTS?: string;

  @IsOptional()
  @IsIn(["true", "false"], {
    message: 'SCVS_QUERY_PIN_DNS_RESOLUTION must be exactly "true" or "false"',
  })
  SCVS_QUERY_PIN_DNS_RESOLUTION?: string;
}
