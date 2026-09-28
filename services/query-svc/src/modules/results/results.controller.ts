import { Controller, Get, Header, Inject, Param } from "@nestjs/common";
import {
  ApiBadRequestResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiServiceUnavailableResponse,
  ApiTooManyRequestsResponse,
} from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import {
  AggregatedWasmStatus,
  DEPRECATED_JSON_ROUTE_DESCRIPTION,
  JSON_ROUTE_SUNSET_HTTP_DATE,
  isNetwork,
  type Network,
} from "@scvs/core";
import { addressThrottleLimit } from "../../config/configuration.js";

import { AggregationReadService } from "../aggregation/aggregation-read.service.js";
import { AggregationSyncService } from "../aggregation/aggregation-sync.service.js";
import { ADDRESS_RESOLVER, MalformedContractIdError, type AddressResolver } from "./address-resolver.js";
import { ApiError, ApiErrorResponse } from "@scvs/http";

@Controller()
export class ResultsController {
  constructor(
    @Inject(AggregationReadService) private readonly reader: AggregationReadService,
    @Inject(AggregationSyncService) private readonly sync: AggregationSyncService,
    @Inject(ADDRESS_RESOLVER) private readonly addresses: AddressResolver,
  ) {}

  /** Must be declared before the canonical route: Express's `:wasm_hash` also matches the dot. */
  @Get("api/query/v1/wasms/:wasm_hash.json")
  @ApiOperation({ operationId: "queryByHashJson", deprecated: true, description: DEPRECATED_JSON_ROUTE_DESCRIPTION })
  @Header("Deprecation", "true")
  @Header("Sunset", JSON_ROUTE_SUNSET_HTTP_DATE)
  @ApiOkResponse({ type: AggregatedWasmStatus })
  queryByHashJson(@Param("wasm_hash") wasmHash: string): Promise<AggregatedWasmStatus> {
    return this.queryByHash(wasmHash);
  }

  @Get("api/query/v1/wasms/:wasm_hash")
  @ApiOkResponse({ type: AggregatedWasmStatus })
  @ApiServiceUnavailableResponse({
    type: ApiErrorResponse,
    description: "aggregation_unavailable — the index is still building",
  })
  async queryByHash(@Param("wasm_hash") wasmHash: string): Promise<AggregatedWasmStatus> {
    this.assertFirstPassComplete();
    return this.reader.byHash(wasmHash.toLowerCase());
  }

  @Get("api/query/v1/contracts/:network/:contract_id")
  /** Decorator arguments are evaluated before any container exists, so the limit is read from `process.env`. */
  @Throttle({ default: { limit: addressThrottleLimit(), ttl: 60_000 } })
  @ApiParam({ name: "network", enum: ["mainnet", "testnet"] })
  @ApiOkResponse({ type: AggregatedWasmStatus })
  @ApiBadRequestResponse({ type: ApiErrorResponse, description: "invalid_network | invalid_contract_id" })
  @ApiNotFoundResponse({
    type: ApiErrorResponse,
    description: "contract_not_found — the address holds no verifiable contract",
  })
  @ApiTooManyRequestsResponse({
    type: ApiErrorResponse,
    description: "rate_limited — this route carries a tighter budget than the rest of the read surface",
  })
  @ApiServiceUnavailableResponse({
    type: ApiErrorResponse,
    description: "aggregation_unavailable — the index is still building",
  })
  async queryByContract(
    @Param("network") networkParam: string,
    @Param("contract_id") contractId: string,
  ): Promise<AggregatedWasmStatus> {
    this.assertFirstPassComplete();
    if (!isNetwork(networkParam)) {
      throw new ApiError(400, { error: "invalid_network", message: "network must be 'mainnet' or 'testnet'" });
    }
    const network: Network = networkParam;

    // Resolved per request, never cached: a contract's Wasm changes on upgrade.
    const wasmHash = await this.resolve(network, contractId);
    return this.reader.byHash(wasmHash.toLowerCase());
  }

  private assertFirstPassComplete(): void {
    if (this.sync.hasCompletedFirstPass) return;
    throw new ApiError(503, {
      error: "aggregation_unavailable",
      message: "the aggregation index is still building; retry shortly",
    });
  }

  private async resolve(network: Network, contractId: string): Promise<string> {
    let resolved: string | undefined;
    try {
      resolved = await this.addresses.resolve(network, contractId);
    } catch (error) {
      if (error instanceof MalformedContractIdError) {
        throw new ApiError(400, { error: "invalid_contract_id", message: error.message });
      }
      throw new ApiError(502, {
        error: "address_resolution_failed",
        message: error instanceof Error ? error.message : String(error),
      });
    }
    if (resolved === undefined) {
      throw new ApiError(404, {
        error: "contract_not_found",
        message: `No Wasm-executable contract at ${contractId} on ${network}`,
      });
    }
    return resolved;
  }
}
