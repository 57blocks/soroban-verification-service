import { Controller, Get, Inject } from "@nestjs/common";
import { ApiOkResponse } from "@nestjs/swagger";
import { TrustedVerifiersList } from "@scvs/storage-layout";
import { VerifiersService } from "./verifiers.service.js";

@Controller("api/query/v1/verifiers")
export class VerifiersController {
  // Explicit `@Inject()` — see aggregator.service.ts's comment (tsx/esbuild doesn't emit the decorator metadata
  // Nest's DI would otherwise infer this parameter's type from).
  constructor(@Inject(VerifiersService) private readonly verifiersService: VerifiersService) {}

  @Get()
  @ApiOkResponse({ type: TrustedVerifiersList })
  list() {
    return this.verifiersService.list();
  }
}
