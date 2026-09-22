import type { Server } from "node:http";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { parseDto, submissionStatuses } from "@scvs/core";
import { ApiErrorResponse } from "../src/common/api-error.dto.js";
import { SubmitIncompleteResponse, SubmitQueuedResponse } from "../src/modules/verifications/submit.dto.js";
import { createTestServer } from "./bootstrap.js";

let server: Server;
beforeAll(async () => {
  server = await createTestServer();
});

// Every arm below reaches the envelope by a different route: a controller `res.json()`, a thrown `ApiError`,
// the catch-all controller, and a middleware that answers before any controller runs.
describe("error envelope", () => {
  it("carries schema_version on a DTO validation rejection", async () => {
    const res = await request(server).post("/api/verification/v1/verifications").send({ target: {} });
    expect(res.status).toBe(400);
    expect(res.body.schema_version).toBe("1.0");
  });

  it("carries schema_version on a route's own 404", async () => {
    const res = await request(server).get(`/api/verification/v1/verifications/${randomUUID()}`);
    expect(res.status).toBe(404);
    expect(res.body.schema_version).toBe("1.0");
  });

  it("carries schema_version on the catch-all 404", async () => {
    const res = await request(server).get("/v1/nothing-here");
    expect(res.status).toBe(404);
    expect(res.body.schema_version).toBe("1.0");
  });

  it("carries schema_version on a rejected upload", async () => {
    const res = await request(server).post("/api/verification/v1/uploads/source").set("content-type", "application/gzip").send();
    expect(res.status).toBe(400);
    expect(res.body.schema_version).toBe("1.0");
  });

  // The arm that answers before any controller runs, and the only one reached from middleware — so it is also
  // the only arm whose envelope the exception filter never gets to repair. The size is declared rather than
  // sent: the middleware refuses on Content-Length alone, and a client still writing a body when the server
  // destroys the socket loses the response to EPIPE before it can read it.
  it("carries schema_version on an upload the middleware refuses outright", async () => {
    const max = Number(process.env.SCVS_MAX_SOURCE_ARCHIVE_BYTES ?? 50 * 1024 * 1024);
    const res = await request(server)
      .post("/api/verification/v1/uploads/source")
      .set("content-type", "application/gzip")
      .set("content-length", String(max + 1))
      .send(Buffer.alloc(8));

    expect(res.status).toBe(413);
    expect(res.body.error).toBe("source_archive_too_large");
    expect(res.body.schema_version).toBe("1.0");
    expect(() => parseDto(ApiErrorResponse, res.body)).not.toThrow();
  });
});

describe("CORS", () => {
  it("allows any origin on a success response", async () => {
    const res = await request(server).get("/api/verification/v1/health").set("Origin", "https://someone-elses.example");
    expect(res.status).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBe("*");
  });

  // The half that regressed elsewhere: a browser that cannot read the error body reports a network failure,
  // which hides the reason the request was rejected.
  it("allows any origin on an error response", async () => {
    const res = await request(server)
      .post("/api/verification/v1/verifications")
      .set("Origin", "https://someone-elses.example")
      .send({ target: {} });
    expect(res.status).toBe(400);
    expect(res.headers["access-control-allow-origin"]).toBe("*");
  });
});

/**
 * The envelope's schema and its runtime shape must not drift, and a type assertion cannot prove that — it would
 * only show the DTO agrees with itself.
 */
describe("the error envelope matches its published schema", () => {
  it("a rejected submission validates against ApiErrorResponse", async () => {
    const res = await request(server).post("/api/verification/v1/verifications").send({ target: {} });

    expect(res.status).toBe(400);
    expect(() => parseDto(ApiErrorResponse, res.body)).not.toThrow();
    // The two the envelope exists to guarantee, spelled out: a code to branch on (RC6) and a sentence to show.
    expect(res.body.error).toBe("invalid_request");
    expect(typeof res.body.message).toBe("string");
    // And no `status` key — the deleted `SubmitErrorResponse` claimed one was required here.
    expect(res.body.status).toBeUndefined();
  });

  it("a route's own 404 validates against it too", async () => {
    const res = await request(server).get(`/api/verification/v1/verifications/${randomUUID()}`);

    expect(res.status).toBe(404);
    expect(() => parseDto(ApiErrorResponse, res.body)).not.toThrow();
  });
});

// The submission status set is closed, and a job status leaking into it is what stalls a conformant client.
describe("submission status set", () => {
  const cases = [
    { dto: SubmitQueuedResponse, status: "queued" },
    { dto: SubmitIncompleteResponse, status: "incomplete" },
  ] as const;

  // The set is declared in `@scvs/core` and in these DTOs.
  it("is exactly what @scvs/core declares", () => {
    expect([...submissionStatuses].sort()).toEqual(cases.map((c) => c.status).sort());
  });

  // Asserting only that the wrong literal throws proves nothing: every variant also has other required fields,
  // so `{status: "building"}` throws on those with or without `@Equals`.
  const statusIssues = (dto: unknown, value: unknown): string[] => {
    try {
      parseDto(dto as never, { status: value });
      return [];
    } catch (error) {
      const issues = (error as { errors?: Array<{ property: string }> }).errors ?? [];
      return issues.filter((issue) => issue.property === "status").map((issue) => issue.property);
    }
  };

  it.each(cases)("$status rejects a job status in its place", ({ dto, status }) => {
    expect(statusIssues(dto, "building")).toEqual(["status"]);
    expect(statusIssues(dto, status)).toEqual([]);
  });
});
