import { Controller, Get, Header, Inject, Query } from "@nestjs/common";
import {
  ApiBadRequestResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiQuery,
  ApiServiceUnavailableResponse,
} from "@nestjs/swagger";
import {
  AggregatedBulkLoadPage,
  DEPRECATED_JSON_ROUTE_DESCRIPTION,
  JSON_ROUTE_SUNSET_HTTP_DATE,
  PAGE_SCHEMA,
  PAGE_SCHEMA_VERSION,
  parseBulkCursor,
  parseBulkLimit,
  parseBulkOrder,
} from "@scvs/core";

import { AggregationReadService } from "./aggregation-read.service.js";
import { AggregationSyncService } from "./aggregation-sync.service.js";
import { ApiError, ApiErrorResponse } from "@scvs/http";

const bulkQueryDocs = [
  { name: "order", required: false, enum: ["asc", "desc"] },
  { name: "limit", required: false, schema: { type: "integer", minimum: 1, maximum: 200, default: 100 } },
  { name: "cursor", required: false, schema: { type: "string" }, description: "{timestamp}-{wasm_hash}" },
] as const;

@ApiTags("Results")
@Controller()
export class BulkLoadController {
  constructor(
    @Inject(AggregationReadService) private readonly reader: AggregationReadService,
    @Inject(AggregationSyncService) private readonly sync: AggregationSyncService,
  ) {}

  @Get("api/query/v1/wasms")
  @ApiOperation({
    operationId: "aggregatedBulkLoad",
    summary: "List aggregated results",
    description: "Pages through every Wasm hash any listed verifier has a result for: one record per hash carrying every verifier's entry, ordered by this aggregator's own update time. Pass back the previous page's `cursor` unchanged and upsert by `wasm_hash`. Until the first sync completes it answers `503 aggregation_unavailable`, not an empty page.",
  })
  @ApiQuery(bulkQueryDocs[0]) @ApiQuery(bulkQueryDocs[1]) @ApiQuery(bulkQueryDocs[2])
  @ApiOkResponse({ type: AggregatedBulkLoadPage })
  @ApiBadRequestResponse({ type: ApiErrorResponse, description: "invalid_order | invalid_limit | invalid_cursor" })
  @ApiServiceUnavailableResponse({
    type: ApiErrorResponse,
    description: "aggregation_unavailable — the index is still building",
  })
  async aggregatedBulkLoad(
    @Query("order") orderParam?: string,
    @Query("limit") limitParam?: string,
    @Query("cursor") cursorParam?: string,
  ): Promise<AggregatedBulkLoadPage> {
    // An empty page before the first pass would read to a consumer as fully synchronised.
    if (!this.sync.hasCompletedFirstPass) {
      throw new ApiError(503, {
        error: "aggregation_unavailable",
        message: "the aggregation index is still building; retry shortly",
      });
    }
    const { order, limit, cursor } = parseBulkQuery(orderParam, limitParam, cursorParam);
    const page = await this.reader.page({ order, limit, ...(cursor ? { cursor } : {}) });
    return {
      schema: PAGE_SCHEMA,
      schema_version: PAGE_SCHEMA_VERSION,
      order,
      cursor: page.cursor,
      records: page.records,
    };
  }

  @Get("api/query/v1/wasms.json")
  @ApiOperation({
    operationId: "aggregatedBulkLoadJson",
    summary: "List aggregated results (deprecated alias)",
    deprecated: true,
    description: DEPRECATED_JSON_ROUTE_DESCRIPTION,
  })
  @Header("Deprecation", "true")
  @Header("Sunset", JSON_ROUTE_SUNSET_HTTP_DATE)
  @ApiQuery(bulkQueryDocs[0]) @ApiQuery(bulkQueryDocs[1]) @ApiQuery(bulkQueryDocs[2])
  @ApiOkResponse({ type: AggregatedBulkLoadPage })
  @ApiBadRequestResponse({ type: ApiErrorResponse, description: "invalid_order | invalid_limit | invalid_cursor" })
  @ApiServiceUnavailableResponse({
    type: ApiErrorResponse,
    description: "aggregation_unavailable — the index is still building",
  })
  aggregatedBulkLoadJson(
    @Query("order") orderParam?: string,
    @Query("limit") limitParam?: string,
    @Query("cursor") cursorParam?: string,
  ): Promise<AggregatedBulkLoadPage> {
    return this.aggregatedBulkLoad(orderParam, limitParam, cursorParam);
  }
}

function parseBulkQuery(orderParam?: string, limitParam?: string, cursorParam?: string) {
  const order = parseBulkOrder(orderParam);
  if (!order) throw new ApiError(400, { error: "invalid_order", message: "order must be 'asc' or 'desc'" });

  const limit = parseBulkLimit(limitParam);
  if (!limit) throw new ApiError(400, { error: "invalid_limit", message: "limit must be an integer between 1 and 200" });

  const cursor = cursorParam === undefined ? undefined : parseBulkCursor(cursorParam);
  if (cursorParam !== undefined && !cursor) {
    throw new ApiError(400, { error: "invalid_cursor", message: "cursor must be {timestamp}-{wasm_hash}" });
  }
  return { order, limit, cursor };
}
