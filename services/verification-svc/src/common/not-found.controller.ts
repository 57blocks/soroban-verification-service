import { All, Controller } from "@nestjs/common";
import { ApiExcludeController } from "@nestjs/swagger";
import { ApiError } from "@scvs/http";

/**
 * Catch-all for unmatched routes, replicating the pre-Nest Express app's final
 * `app.use((_req,res)=>res.status(404).json({...}))`.
 */
@ApiExcludeController()
@Controller()
export class NotFoundController {
  @All("*path")
  handleNotFound(): never {
    throw new ApiError(404, { error: "not_found", message: "Endpoint not found" });
  }
}
