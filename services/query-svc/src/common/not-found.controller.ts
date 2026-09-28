import { All, Controller } from "@nestjs/common";
import { ApiExcludeController } from "@nestjs/swagger";
import { ApiError } from "@scvs/http";

@ApiExcludeController()
@Controller()
export class NotFoundController {
  @All("*path")
  handleNotFound(): never {
    throw new ApiError(404, { error: "not_found", message: "No such route." });
  }
}
