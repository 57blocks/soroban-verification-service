import type { Server } from "node:http";
import request from "supertest";
import { sanitizeRequestId } from "../src/common/request-id.middleware.js";
import { createTestServer } from "./bootstrap.js";

let server: Server;
beforeAll(async () => {
  server = await createTestServer();
});

/** O2's pre-job leg. `job_id` covers submission → build → publication on its own. */
describe("x-request-id", () => {
  it("mints one when the caller sends none, and echoes it", async () => {
    const res = await request(server).get("/health");
    expect(res.status).toBe(200);
    expect(res.headers["x-request-id"]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("honours a caller-supplied id", async () => {
    const res = await request(server).get("/health").set("x-request-id", "console-42_a.b");
    expect(res.headers["x-request-id"]).toBe("console-42_a.b");
  });

  it("replaces a hostile id rather than echoing it", async () => {
    // The header is submitter-controlled text that lands in a log record and in a response header.
    const res = await request(server)
      .get("/health")
      .set("x-request-id", 'evil" }{ "level":"error","msg":"forged');

    expect(res.headers["x-request-id"]).not.toContain("forged");
    expect(res.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("applies to every route, including an unmatched one", async () => {
    const res = await request(server).get("/v1/does-not-exist");
    expect(res.status).toBe(404);
    expect(res.headers["x-request-id"]).toBeDefined();
  });
});

describe("sanitizeRequestId", () => {
  it("accepts a conservative character set and rejects everything else", () => {
    expect(sanitizeRequestId("abc-123_x.Y")).toBe("abc-123_x.Y");
    expect(sanitizeRequestId("has space")).toBeUndefined();
    expect(sanitizeRequestId("newline\n")).toBeUndefined();
    expect(sanitizeRequestId("quote\"")).toBeUndefined();
    expect(sanitizeRequestId("")).toBeUndefined();
    expect(sanitizeRequestId(undefined)).toBeUndefined();
  });

  it("rejects an over-long id rather than truncating it", () => {
    // Truncating would map two different requests onto the same id, which is worse than minting one.
    expect(sanitizeRequestId("a".repeat(128))).toBe("a".repeat(128));
    expect(sanitizeRequestId("a".repeat(129))).toBeUndefined();
  });
});
