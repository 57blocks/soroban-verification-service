import assert from "node:assert/strict";
import { classifyConditionalWriteError } from "./s3.js";

const named = (name: string, httpStatusCode?: number) => ({ name, $metadata: { httpStatusCode } });

function main(): void {
  // Condition failed: a conflict under either mode — re-read and recompute.
  assert.equal(classifyConditionalWriteError(named("PreconditionFailed", 412), "if-match"), "conflict");
  assert.equal(classifyConditionalWriteError(named("PreconditionFailed", 412), "if-none-match"), "conflict");
  assert.equal(classifyConditionalWriteError(named("ConditionalRequestConflict", 409), "if-match"), "conflict");

  // Raced by a delete: only If-Match can see it, and it is replayable. If-None-Match cannot produce it.
  assert.equal(classifyConditionalWriteError(named("NoSuchKey", 404), "if-match"), "vanished");
  assert.equal(classifyConditionalWriteError(named("NoSuchKey", 404), "if-none-match"), "fatal");

  // A missing bucket or a permission problem — including one disguised as a 404 — is never retried.
  assert.equal(classifyConditionalWriteError(named("NoSuchBucket", 404), "if-match"), "fatal");
  assert.equal(classifyConditionalWriteError(named("AccessDenied", 404), "if-match"), "fatal");
  assert.equal(classifyConditionalWriteError(named("AccessDenied", 403), "if-match"), "fatal");

  // The status code is consulted only when the response carries no error name, and still splits by mode.
  assert.equal(classifyConditionalWriteError({ $metadata: { httpStatusCode: 412 } }, "if-match"), "conflict");
  assert.equal(classifyConditionalWriteError({ $metadata: { httpStatusCode: 409 } }, "if-match"), "conflict");
  assert.equal(classifyConditionalWriteError({ $metadata: { httpStatusCode: 404 } }, "if-match"), "vanished");
  assert.equal(classifyConditionalWriteError({ $metadata: { httpStatusCode: 404 } }, "if-none-match"), "fatal");
  assert.equal(classifyConditionalWriteError({ $metadata: { httpStatusCode: 500 } }, "if-match"), "fatal");

  // A non-object input must not throw.
  assert.equal(classifyConditionalWriteError(undefined, "if-match"), "fatal");
  assert.equal(classifyConditionalWriteError("boom", "if-match"), "fatal");

  console.log("S3 conditional-write error classification passed");
}

main();
