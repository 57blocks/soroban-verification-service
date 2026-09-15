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
import { ApiErrorResponse } from "../../common/api-error.dto.js";
import { ApiError } from "../../common/api-error.exception.js";
import { AggregationReadService } from "../aggregation/aggregation-read.service.js";
import { AggregationSyncService } from "../aggregation/aggregation-sync.service.js";
import { ADDRESS_RESOLVER, MalformedContractIdError, type AddressResolver } from "./address-resolver.js";

/** The aggregated read surface: one entry per verifier, in the Registry's own vocabulary. */
@Controller()
export class ResultsController {
  constructor(
    @Inject(AggregationReadService) private readonly reader: AggregationReadService,
    @Inject(AggregationSyncService) private readonly sync: AggregationSyncService,
    @Inject(ADDRESS_RESOLVER) private readonly addresses: AddressResolver,
  ) {}

  /**
   * **Declared before the canonical route on purpose, and the order is load-bearing.** Express's `:wasm_hash`
   * matches greedily and takes the dot with it, so `/wasms/abc.json` matches the route below too.
   */
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
  /**
   * The only route on this service that reaches a third party: resolving an address is one outbound Soroban RPC
   * call per request, uncached by design (see `resolve` below), so one admitted request here costs an upstream
   * request too. That is why this tier is an order of magnitude tighter than the global one — it is sized
   * against what the upstream endpoint tolerates, not against what this service could serve.
   *
   * `@Throttle` REPLACES the global limit for this route rather than stacking a second window under it, so this
   * number must stay BELOW `SCVS_QUERY_THROTTLE_LIMIT` or it widens the budget instead of narrowing it.
   *
   * Reads `process.env` directly rather than through `ConfigService`, the same documented exception
   * verification-svc's upload route takes: a decorator argument is evaluated when the class is defined, before
   * Nest's container exists. The value is therefore fixed at import time — changing it needs a restart.
   */
  @Throttle({
    default: { limit: Number(process.env.SCVS_QUERY_ADDRESS_THROTTLE_LIMIT || 60), ttl: 60_000 },
  })
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
    // Before resolving: an answer we cannot give is not worth a ledger round-trip.
    this.assertFirstPassComplete();
    if (!isNetwork(networkParam)) {
      throw new ApiError(400, { error: "invalid_network", message: "network must be 'mainnet' or 'testnet'" });
    }
    const network: Network = networkParam;

    // Re-resolved per request, never read from a published file: the mapping changes on upgrade, and a stale
    // pointer would attribute a verdict to code that is no longer deployed.
    const wasmHash = await this.resolve(network, contractId);
    return this.reader.byHash(wasmHash.toLowerCase());
  }

  /**
   * `agreement: "no_data"` with an empty `unavailable_verifiers` asserts that every member was asked and none
   * had a result. Before the first pass none of them has been asked, so the same body would be a lie a
   * consumer cannot detect — the reason `GET /v1/wasms` refuses too.
   */
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
      // Failing to reach the ledger is not the same as the address having no subject, and it is not an
      // unavailable *verifier* either — the request has no subject at all.
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
