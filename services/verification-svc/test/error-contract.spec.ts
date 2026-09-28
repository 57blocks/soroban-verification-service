import type { Server } from "node:http";
import { randomUUID } from "node:crypto";
import request from "supertest";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { parseDto, submissionStatuses } from "@scvs/core";
import { ApiErrorResponse } from "@scvs/http";
import { SubmitIncompleteResponse, SubmitQueuedResponse } from "../src/modules/verifications/submit.dto.js";
import { createTestApp } from "./bootstrap.js";

let app: NestExpressApplication;
let server: Server;
beforeAll(async () => {
  app = await createTestApp();
  server = app.getHttpServer();
});

afterAll(async () => {
  await app?.close();
});

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

  // The size is declared, not sent: a client still writing when the socket is destroyed loses the response to EPIPE.
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

  it("allows any origin on an error response", async () => {
    const res = await request(server)
      .post("/api/verification/v1/verifications")
      .set("Origin", "https://someone-elses.example")
      .send({ target: {} });
    expect(res.status).toBe(400);
    expect(res.headers["access-control-allow-origin"]).toBe("*");
  });
});

describe("the error envelope matches its published schema", () => {
  it("a rejected submission validates against ApiErrorResponse", async () => {
    const res = await request(server).post("/api/verification/v1/verifications").send({ target: {} });

    expect(res.status).toBe(400);
    expect(() => parseDto(ApiErrorResponse, res.body)).not.toThrow();
    expect(res.body.error).toBe("invalid_request");
    expect(typeof res.body.message).toBe("string");
    expect(res.body.status).toBeUndefined();
  });

  it("a route's own 404 validates against it too", async () => {
    const res = await request(server).get(`/api/verification/v1/verifications/${randomUUID()}`);

    expect(res.status).toBe(404);
    expect(() => parseDto(ApiErrorResponse, res.body)).not.toThrow();
  });
});

describe("submission status set", () => {
  const cases = [
    { dto: SubmitQueuedResponse, status: "queued" },
    { dto: SubmitIncompleteResponse, status: "incomplete" },
  ] as const;

  it("is exactly what @scvs/core declares", () => {
    expect([...submissionStatuses].sort()).toEqual(cases.map((c) => c.status).sort());
  });

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
