import { All, Controller } from "@nestjs/common";
import { ApiExcludeController } from "@nestjs/swagger";
import { ApiError } from "./api-error.exception.js";

// A catch-all `*path` isn't a real operation and shouldn't appear in the OpenAPI document.
@ApiExcludeController()
@Controller()
export class NotFoundController {
  @All("*path")
  handleNotFound(): never {
    throw new ApiError(404, { error: "not_found", message: "No such route." });
  }
}
