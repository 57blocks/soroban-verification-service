import "reflect-metadata";
import assert from "node:assert/strict";
import { plainToInstance } from "class-transformer";
import { validateSync } from "class-validator";
import { ERROR_SCHEMA, ERROR_SCHEMA_VERSION } from "@scvs/core";
import { ApiError, errorBody } from "./api-error.js";
import { ApiErrorResponse } from "./api-error.dto.js";

function test(name: string, fn: () => void): void {
  fn();
  console.log(`ok - ${name}`);
}

function problems(body: unknown): string[] {
  return validateSync(plainToInstance(ApiErrorResponse, body)).map((e) => e.property);
}

test("errorBody stamps both identifiers and the status code", () => {
  assert.deepEqual(errorBody(404, { error: "not_found", message: "No such route." }), {
    schema: ERROR_SCHEMA,
    schema_version: ERROR_SCHEMA_VERSION,
    error: "not_found",
    message: "No such route.",
    status_code: 404,
  });
});

// The index signature on `ErrorDetail` would otherwise let a caller overwrite the two things the envelope
// exists to guarantee — `errorEnvelope` spreads them last for this reason.
test("a caller cannot overwrite the envelope identifiers", () => {
  const body = errorBody(400, {
    error: "invalid_request",
    message: "no",
    schema: "something-else",
    schema_version: "9.9",
  });
  assert.equal(body.schema, ERROR_SCHEMA);
  assert.equal(body.schema_version, ERROR_SCHEMA_VERSION);
});

test("status_code survives the ApiError round trip", () => {
  const thrown = new ApiError(429, { error: "rate_limited", message: "Slow down." });
  const body = thrown.getResponse() as Record<string, unknown>;
  assert.equal(thrown.getStatus(), 429);
  assert.equal(body.status_code, 429);
});

test("every errorBody output validates against the published DTO", () => {
  assert.deepEqual(problems(errorBody(500, { error: "internal_error", message: "boom" })), []);
});

// The drift this package exists to end: one service required `status_code`, the other made it optional, for
// a field no code path has ever omitted.
test("a body without status_code is rejected", () => {
  assert.deepEqual(
    problems({ schema: ERROR_SCHEMA, schema_version: ERROR_SCHEMA_VERSION, error: "x", message: "y" }),
    ["status_code"],
  );
});

test("the optional diagnostic fields stay optional", () => {
  assert.deepEqual(problems(errorBody(400, { error: "x", message: "y", detail: "d", reason: "r" })), []);
  assert.deepEqual(problems(errorBody(400, { error: "x", message: "y" })), []);
});

test("a foreign schema identifier is rejected", () => {
  assert.deepEqual(
    problems({ schema: "other", schema_version: ERROR_SCHEMA_VERSION, error: "x", message: "y", status_code: 400 }),
    ["schema"],
  );
});
