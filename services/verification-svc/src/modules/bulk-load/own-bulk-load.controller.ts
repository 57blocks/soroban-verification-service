import { Controller, Get, Header, Inject, Query } from "@nestjs/common";
import {
  ApiBadRequestResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTooManyRequestsResponse,
} from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { JobsRepository } from "@scvs/db";
import {
  DEPRECATED_JSON_ROUTE_DESCRIPTION,
  JSON_ROUTE_SUNSET_HTTP_DATE,
  OwnBulkLoadPage,
  PAGE_SCHEMA,
  PAGE_SCHEMA_VERSION,
  parseBulkCursor,
  parseBulkLimit,
  parseBulkOrder,
} from "@scvs/core";
import { ApiError, ApiErrorResponse } from "@scvs/http";
import { readThrottleLimit } from "../../config/configuration.js";

const bulkQueryDocs = [
  { name: "order", required: false, enum: ["asc", "desc"] },
  { name: "limit", required: false, schema: { type: "integer", minimum: 1, maximum: 200, default: 100 } },
  { name: "cursor", required: false, schema: { type: "string" }, description: "{timestamp}-{wasm_hash}" },
] as const;

@Controller()
export class OwnBulkLoadController {
  constructor(@Inject(JobsRepository) private readonly jobs: JobsRepository) {}

  @Get("api/verification/v1/wasms")
  @Throttle({ default: { limit: readThrottleLimit(), ttl: 60_000 } })
  @ApiOperation({ operationId: "ownBulkLoad" })
  @ApiQuery(bulkQueryDocs[0])
  @ApiQuery(bulkQueryDocs[1])
  @ApiQuery(bulkQueryDocs[2])
  @ApiOkResponse({ type: OwnBulkLoadPage })
  @ApiBadRequestResponse({ description: "invalid_order | invalid_limit | invalid_cursor" })
  @ApiTooManyRequestsResponse({ type: ApiErrorResponse, description: "rate_limited" })
  async bulkLoad(
    @Query("order") orderParam?: string,
    @Query("limit") limitParam?: string,
    @Query("cursor") cursorParam?: string,
  ): Promise<OwnBulkLoadPage> {
    const { order, limit, cursor } = parseBulkQuery(orderParam, limitParam, cursorParam);
    const rows = await this.jobs.listPublished({ order, limit, ...(cursor ? { cursor } : {}) });
    const last = rows.at(-1);
    return {
      schema: PAGE_SCHEMA,
      schema_version: PAGE_SCHEMA_VERSION,
      order,
      cursor: rows.length === limit && last ? `${new Date(last.publishedUpdatedAt).getTime()}-${last.wasmHash}` : null,
      records: rows.map((row) => ({ wasm_hash: row.wasmHash, updated_at: row.publishedUpdatedAt })),
    };
  }

  @Get("api/verification/v1/wasms.json")
  @Throttle({ default: { limit: readThrottleLimit(), ttl: 60_000 } })
  @ApiOperation({ operationId: "ownBulkLoadJson", deprecated: true, description: DEPRECATED_JSON_ROUTE_DESCRIPTION })
  @Header("Deprecation", "true")
  @Header("Sunset", JSON_ROUTE_SUNSET_HTTP_DATE)
  @ApiQuery(bulkQueryDocs[0])
  @ApiQuery(bulkQueryDocs[1])
  @ApiQuery(bulkQueryDocs[2])
  @ApiOkResponse({ type: OwnBulkLoadPage })
  @ApiBadRequestResponse({ description: "invalid_order | invalid_limit | invalid_cursor" })
  @ApiTooManyRequestsResponse({ type: ApiErrorResponse, description: "rate_limited" })
  bulkLoadJson(
    @Query("order") orderParam?: string,
    @Query("limit") limitParam?: string,
    @Query("cursor") cursorParam?: string,
  ): Promise<OwnBulkLoadPage> {
    return this.bulkLoad(orderParam, limitParam, cursorParam);
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
