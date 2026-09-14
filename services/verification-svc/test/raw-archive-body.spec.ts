import { jest } from "@jest/globals";
import { EventEmitter } from "node:events";
import type { Request, Response } from "express";
import { RawArchiveBodyMiddleware } from "../src/common/raw-archive-body.middleware.js";
import type { AbuseGuardService } from "../src/common/abuse-guard.js";
import type { DrainState } from "@scvs/core";

const MAX_BYTES = 1024;

function configService() {
  return { get: () => MAX_BYTES } as unknown as ConstructorParameters<typeof RawArchiveBodyMiddleware>[0];
}

/** Allows every request by default; `allowed: false` exercises the rate-limit branch. */
function abuseGuardService(allowed = true) {
  return {
    checkAbuse: jest.fn().mockResolvedValue({ allowed }),
  } as unknown as AbuseGuardService;
}

/** Not draining by default; `draining: true` exercises the drain-rejection branch. */
function drainState(draining = false) {
  return { isDraining: draining } as unknown as DrainState;
}

/** `req` is a readable stream; the middleware only touches `headers`, `on`, and `destroy`. */
class FakeRequest extends EventEmitter {
  headers: Record<string, string> = {};
  destroy = jest.fn();
  body?: unknown;
}

function fakeResponse() {
  const res = {
    status: jest.fn(),
    json: jest.fn(),
  };
  res.status.mockReturnValue(res);
  return res as unknown as Response & { status: jest.Mock; json: jest.Mock };
}

describe("RawArchiveBodyMiddleware", () => {
  it("rejects while draining, before the abuse check runs at all", async () => {
    const abuse = abuseGuardService();
    const middleware = new RawArchiveBodyMiddleware(configService(), abuse, drainState(true));
    const req = new FakeRequest();
    const res = fakeResponse();
    const next = jest.fn();

    await middleware.use(req as unknown as Request, res, next);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: "draining" }));
    expect(req.destroy).toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
    // Draining must not spend the submitter's abuse-check budget — same ordering the submit route's
    // DrainGuard-before-AbuseGuard controller guards enforce.
    expect(abuse.checkAbuse).not.toHaveBeenCalled();
  });

  it("rejects over the abuse budget before reading any body, without buffering a chunk", async () => {
    const middleware = new RawArchiveBodyMiddleware(configService(), abuseGuardService(false), drainState());
    const req = new FakeRequest();
    const res = fakeResponse();
    const next = jest.fn();
    const dataListener = jest.fn();
    req.on("data", dataListener);

    await middleware.use(req as unknown as Request, res, next);

    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: "rate_limited" }));
    expect(req.destroy).toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();

    // No new "data" listener was registered by the middleware itself — confirms it returned before wiring
    // the per-chunk accumulator.
    req.emit("data", Buffer.from("x"));
    expect(dataListener).toHaveBeenCalledTimes(1);
  });

  it("fails open when the abuse check itself errors", async () => {
    const abuse = { checkAbuse: jest.fn().mockRejectedValue(new Error("db down")) } as unknown as AbuseGuardService;
    const middleware = new RawArchiveBodyMiddleware(configService(), abuse, drainState());
    const req = new FakeRequest();
    req.headers["content-length"] = "6";
    const res = fakeResponse();
    const next = jest.fn();

    await middleware.use(req as unknown as Request, res, next);
    req.emit("data", Buffer.from("abcdef"));
    req.emit("end");

    expect(res.status).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("rejects before reading any body when Content-Length already exceeds the ceiling", async () => {
    const middleware = new RawArchiveBodyMiddleware(configService(), abuseGuardService(), drainState());
    const req = new FakeRequest();
    req.headers["content-length"] = String(MAX_BYTES + 1);
    const res = fakeResponse();
    const next = jest.fn();
    const dataListener = jest.fn();
    req.on("data", dataListener);

    await middleware.use(req as unknown as Request, res, next);

    expect(res.status).toHaveBeenCalledWith(413);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: "source_archive_too_large" }),
    );
    expect(req.destroy).toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();

    // No new "data" listener was registered by the middleware itself — confirms it returned before wiring
    // the per-chunk accumulator.
    req.emit("data", Buffer.from("x"));
    expect(dataListener).toHaveBeenCalledTimes(1);
  });

  it("accepts a request with no Content-Length and falls back to the per-chunk ceiling", async () => {
    const middleware = new RawArchiveBodyMiddleware(configService(), abuseGuardService(), drainState());
    const req = new FakeRequest();
    const res = fakeResponse();
    const next = jest.fn();

    await middleware.use(req as unknown as Request, res, next);
    req.emit("data", Buffer.alloc(MAX_BYTES + 1));

    expect(res.status).toHaveBeenCalledWith(413);
    expect(req.destroy).toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it("buffers chunks and calls next() with the assembled body when under the ceiling", async () => {
    const middleware = new RawArchiveBodyMiddleware(configService(), abuseGuardService(), drainState());
    const req = new FakeRequest();
    req.headers["content-length"] = "6";
    const res = fakeResponse();
    const next = jest.fn();

    await middleware.use(req as unknown as Request, res, next);
    req.emit("data", Buffer.from("abc"));
    req.emit("data", Buffer.from("def"));
    req.emit("end");

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
    expect((req as unknown as { body: Buffer }).body).toEqual(Buffer.from("abcdef"));
  });

  it("assembles the body correctly with no Content-Length to size the initial allocation by", async () => {
    const middleware = new RawArchiveBodyMiddleware(configService(), abuseGuardService(), drainState());
    const req = new FakeRequest();
    const res = fakeResponse();
    const next = jest.fn();

    await middleware.use(req as unknown as Request, res, next);
    req.emit("data", Buffer.from("abc"));
    req.emit("data", Buffer.from("def"));
    req.emit("end");

    expect(next).toHaveBeenCalledTimes(1);
    expect((req as unknown as { body: Buffer }).body).toEqual(Buffer.from("abcdef"));
  });

  it("grows the buffer and keeps the full body when actual bytes outgrow an understated Content-Length", async () => {
    const middleware = new RawArchiveBodyMiddleware(configService(), abuseGuardService(), drainState());
    const req = new FakeRequest();
    req.headers["content-length"] = "2"; // undersold: the client actually sends more
    const res = fakeResponse();
    const next = jest.fn();

    await middleware.use(req as unknown as Request, res, next);
    req.emit("data", Buffer.from("ab"));
    // 6 bytes against a 2-byte initial allocation: doubling once (to 4) would still undershoot, exercising the
    // max(buffer.length * 2, size) branch rather than just size > buffer.length.
    req.emit("data", Buffer.from("cdefgh"));
    req.emit("end");

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
    expect((req as unknown as { body: Buffer }).body).toEqual(Buffer.from("abcdefgh"));
  });
});
