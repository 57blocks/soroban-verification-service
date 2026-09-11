import { Controller, Get, Inject, Res } from "@nestjs/common";
import { ApiOkResponse, ApiOperation } from "@nestjs/swagger";
import type { Response } from "express";
import { LegalDocumentsBundle } from "./legal.dto.js";
import { LegalService } from "./legal.service.js";

@Controller()
export class LegalController {
  // Explicit `@Inject()` on every parameter — see preflight.controller.ts's comment.
  constructor(@Inject(LegalService) private readonly legal: LegalService) {}

  @Get("api/verification/v1/legal")
  @ApiOperation({ operationId: "getLegalDocuments" })
  @ApiOkResponse({ type: LegalDocumentsBundle })
  getLegalDocuments(@Res() res: Response): void {
    // The operator's bytes, verbatim: the ETag is their sha256, and it is the same hash a job binds, so
    // "the hash of the text shown" is an identity rather than an invariant to maintain.
    res.setHeader("ETag", `"${this.legal.contentSha256()}"`);
    // Public text rather than job content, so retention-and-pseudonymisation design.md RP-5's `no-store`
    // does not reach it; a short window keeps a submitter's version fresh.
    res.setHeader("Cache-Control", "public, max-age=60");
    res.status(200).type("application/json").send(this.legal.raw());
  }
}
