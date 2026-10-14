import { Controller, Get, Inject } from "@nestjs/common";
import { ApiOkResponse, ApiOperation, ApiTags } from "@nestjs/swagger";
import { TrustedVerifiersList } from "@scvs/storage-layout";
import { VerifiersService } from "./verifiers.service.js";

@ApiTags("Verifiers")
@Controller("api/query/v1/verifiers")
export class VerifiersController {
  // Explicit `@Inject()`: tsx/esbuild emits no decorator metadata.
  constructor(@Inject(VerifiersService) private readonly verifiersService: VerifiersService) {}

  @Get()
  @ApiOperation({
    summary: "List the trusted verifiers",
    description: "Returns this aggregator's Trusted Verifiers List: every verifier it reads, paused and disabled ones included, each with its `status`.",
  })
  @ApiOkResponse({ type: TrustedVerifiersList })
  list() {
    return this.verifiersService.list();
  }
}
