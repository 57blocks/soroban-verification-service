import { Controller, Get, Inject, Param, Res } from "@nestjs/common";
import { SkipThrottle } from "@nestjs/throttler";
import {
  ApiAcceptedResponse,
  ApiBadRequestResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiResponse,
} from "@nestjs/swagger";
import { RegistryStatusObject } from "@scvs/core";
import type { Response } from "express";
import {
  RegistryErrorResponse,
  RegistryNotFoundResponse,
  RegistryStorageUnavailableResponse,
} from "./wasms.dto.js";
import { WasmsService } from "./wasms.service.js";

@Controller()
export class WasmsController {
  constructor(@Inject(WasmsService) private readonly wasms: WasmsService) {}

  @Get("api/verification/v1/wasms/:wasm_hash.json")
  @SkipThrottle()
  @ApiOperation({ operationId: "getWasmStatus" })
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
