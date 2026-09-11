import { Body, Controller, Inject, Post, Res, UseGuards, UsePipes, ValidationPipe } from "@nestjs/common";
import { ApiBadRequestResponse, ApiBody, ApiOkResponse, ApiOperation, ApiTooManyRequestsResponse } from "@nestjs/swagger";
import { PreflightResponse } from "./preflight.dto.js";
import type { Response } from "express";
import { AbuseGuard } from "../../common/abuse.guard.js";
import { ApiError, errorBody } from "../../common/api-error.exception.js";
import { mapPreflightIssues, PreflightRequestDto } from "./preflight.dto.js";
import { PreflightService } from "./preflight.service.js";

@Controller("api/verification/v1/preflight")
@UseGuards(AbuseGuard)
export class PreflightController {
  // `@Inject()` is required here.
  constructor(@Inject(PreflightService) private readonly preflightService: PreflightService) {}

  @Post()
  @ApiOperation({ operationId: "preflightVerification" })
  @ApiBody({ type: PreflightRequestDto })
  @ApiOkResponse({ type: PreflightResponse })
  @ApiBadRequestResponse({ description: "invalid_network | missing_target | invalid_request" })
  @ApiTooManyRequestsResponse({ description: "rate_limited" })
  @UsePipes(
    new ValidationPipe({
      transform: true,
      exceptionFactory: (errors) => {
        const mapped = mapPreflightIssues(errors);
        return new ApiError(mapped.status_code, mapped);
      },
    }),
  )
  async preflight(@Body() body: PreflightRequestDto, @Res() res: Response): Promise<void> {
    const preflight = await this.preflightService.run(body);
    if (!preflight.ok) {
      const statusCode = preflight.status === "not_found" ? 404 : 502;
      res.status(statusCode).json(errorBody(statusCode, { error: preflight.status, reason: preflight.reason, message: preflight.detail }));
      return;
    }

    res.status(200).json({
      target: preflight.target,
      wasm_hash: preflight.wasm_hash,
      wasm_byte_size: preflight.wasm_byte_size,
      metadata: { available: preflight.available_fields, missing: preflight.missing_fields },
      available_fields: preflight.available_fields,
      missing_fields: preflight.missing_fields,
      suggested_manifest: preflight.suggested_manifest,
      build_environment: preflight.build_environment,
      prefill: preflight.prefill,
    });
  }
}
