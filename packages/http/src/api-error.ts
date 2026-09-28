import { HttpException } from "@nestjs/common";
import { errorEnvelope, ERROR_SCHEMA, ERROR_SCHEMA_VERSION, type ErrorDetail } from "@scvs/core";

export { ERROR_SCHEMA, ERROR_SCHEMA_VERSION };
export type { ErrorDetail };

export type ApiErrorBody = {
  schema: typeof ERROR_SCHEMA;
  schema_version: typeof ERROR_SCHEMA_VERSION;
  error: string;
  message: string;
  status_code: number;
  [key: string]: unknown;
};

export function errorBody(statusCode: number, body: ErrorDetail): ApiErrorBody {
  return { ...errorEnvelope(body), status_code: statusCode };
}

export class ApiError extends HttpException {
  constructor(statusCode: number, body: ErrorDetail) {
    super(errorBody(statusCode, body), statusCode);
  }
}
