import { Controller, Get, Inject, Res } from "@nestjs/common";
import { ApiOkResponse, ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Response } from "express";
import { LegalDocumentsBundle } from "./legal.dto.js";
import { LegalService } from "./legal.service.js";

@ApiTags("Legal")
@Controller()
export class LegalController {
  constructor(@Inject(LegalService) private readonly legal: LegalService) {}

  @Get("api/verification/v1/legal")
  @ApiOperation({
    operationId: "getLegalDocuments",
    summary: "Get the Terms of Service and Privacy Notice",
    description: "Returns the operator's legal documents as one bundle under a single `version`. The `ETag` is the SHA-256 of the exact bytes served. A submission accepts them by naming that `version` in `accepted_terms_version`.",
  })
  @ApiOkResponse({ type: LegalDocumentsBundle })
  getLegalDocuments(@Res() res: Response): void {
    // Served verbatim: the ETag is the sha256 a job binds, so the body must be exactly the hashed bytes.
    res.setHeader("ETag", `"${this.legal.contentSha256()}"`);
    res.setHeader("Cache-Control", "public, max-age=60");
    res.status(200).type("application/json").send(this.legal.raw());
  }
}
