import { Controller, Get, Inject, Param, Res } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import {
  ApiAcceptedResponse,
  ApiBadRequestResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
} from "@nestjs/swagger";
import { RegistryStatusObject } from "@scvs/core";
import { ApiErrorResponse } from "@scvs/http";
import type { Response } from "express";
import {
  RegistryErrorResponse,
  RegistryNotFoundResponse,
  RegistryStorageUnavailableResponse,
} from "./wasms.dto.js";
import { WasmsService } from "./wasms.service.js";
import { readThrottleLimit } from "../../config/configuration.js";

@ApiTags("Results")
@Controller()
export class WasmsController {
  constructor(@Inject(WasmsService) private readonly wasms: WasmsService) {}

  @Get("api/verification/v1/wasms/:wasm_hash.json")
  @Throttle({ default: { limit: readThrottleLimit(), ttl: 60_000 } })
  @ApiOperation({
    operationId: "getWasmStatus",
    summary: "Get this verifier's result for a Wasm hash",
    description: "Returns the status object this verifier published for the hash, byte for byte as it sits in the result root. Answers `202` with an `unverified` entry while any verification of the hash is queued or running, a dry run included, even when a result is already published; and `404` when nothing is published and nothing is in flight.",
  })
  @ApiParam({
    name: "wasm_hash",
    schema: { type: "string", pattern: "^[0-9a-fA-F]{64}$" },
    description: "SHA-256 of the Wasm. Uppercase input is accepted and normalised.",
  })
  @ApiOkResponse({
    type: RegistryStatusObject,
    description:
      "The published status object, byte-identical to the result root's wasms/{wasm_hash}.json.",
  })
  @ApiAcceptedResponse({
    type: RegistryStatusObject,
    description:
      "A verification for this hash is queued or running. Same schema as the 200 body; the entry carries status `unverified` and the status code carries the in-flight signal.",
  })
  @ApiBadRequestResponse({
    type: RegistryErrorResponse,
    description: "400_invalid_wasm_hash — the SEP envelope with the closed vocabulary this status keeps.",
  })
  @ApiNotFoundResponse({
    type: RegistryNotFoundResponse,
    description: "No published verification and none in flight.",
  })
  @ApiTooManyRequestsResponse({ type: ApiErrorResponse, description: "rate_limited" })
  @ApiResponse({
    status: 503,
    type: RegistryStorageUnavailableResponse,
    description: "Result storage is unconfigured or unreadable.",
  })
  async get(@Param("wasm_hash") wasmHash: string, @Res() res: Response): Promise<void> {
    const result = await this.wasms.get(wasmHash);
    switch (result.statusCode) {
      case 200:
        // Raw bytes with the same content type the CDN serves, so the two forms are byte-identical.
        res.status(200).type("application/json").send(result.text);
        return;
      default:
        res.status(result.statusCode).json(result.body);
    }
  }
}
