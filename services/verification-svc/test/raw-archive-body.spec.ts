import { jest } from "@jest/globals";
import { EventEmitter } from "node:events";
import type { Request, Response } from "express";
import { RawArchiveBodyMiddleware } from "../src/common/raw-archive-body.middleware.js";
import type { AbuseCheckResult, AbuseGuardService } from "../src/common/abuse-guard.js";
import { UPLOAD_SOURCE_ROUTE } from "../src/common/abuse.guard.js";
import type { DrainState } from "@scvs/core";

const MAX_BYTES = 1024;

function configService() {
  return { get: () => MAX_BYTES } as unknown as ConstructorParameters<typeof RawArchiveBodyMiddleware>[0];
}

function abuseGuardService(result: AbuseCheckResult = { allowed: true }) {
  return {
    checkAbuseFailOpen: jest.fn().mockResolvedValue(result),
  } as unknown as AbuseGuardService;
}

function drainState(draining = false) {
  return { isDraining: draining } as unknown as DrainState;
}

class FakeRequest extends EventEmitter {
  headers: Record<string, string> = {};
  destroy = jest.fn();
  resume = jest.fn();
  body?: unknown;
}

/** A real EventEmitter, not a jest.fn() stub: the middleware registers a real "finish" listener. */
class FakeResponse extends EventEmitter {
  status = jest.fn().mockReturnThis();
  json = jest.fn();

  emitFinish(): void {
    this.emit("finish");
  }
}

function fakeResponse() {
  return new FakeResponse() as unknown as Response & FakeResponse;
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
    expect(req.resume).toHaveBeenCalled();
    expect(req.destroy).not.toHaveBeenCalled();
    res.emitFinish();
    expect(req.destroy).toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
    expect(abuse.checkAbuseFailOpen).not.toHaveBeenCalled();
  });

  it("rejects over the abuse budget before reading any body, without buffering a chunk", async () => {
    const middleware = new RawArchiveBodyMiddleware(
      configService(),
      abuseGuardService({ allowed: false, reason: "rate_limited" }),
      drainState(),
    );
    const req = new FakeRequest();
    const res = fakeResponse();
    const next = jest.fn();
    const dataListener = jest.fn();
    req.on("data", dataListener);

    await middleware.use(req as unknown as Request, res, next);

    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: "rate_limited" }));
    res.emitFinish();
    expect(req.destroy).toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();

    req.emit("data", Buffer.from("x"));
    expect(dataListener).toHaveBeenCalledTimes(1);
  });

  it("rejects with 503 rather than admitting the request once checkAbuseFailOpen reports fail_closed", async () => {
    const middleware = new RawArchiveBodyMiddleware(
      configService(),
      abuseGuardService({ allowed: false, reason: "fail_closed" }),
      drainState(),
    );
    const req = new FakeRequest();
    const res = fakeResponse();
    const next = jest.fn();

    await middleware.use(req as unknown as Request, res, next);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: "abuse_check_unavailable" }));
    res.emitFinish();
    expect(req.destroy).toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it("keys the abuse check on the exact route string AbuseGuard's SUBMISSION_ROUTES would have used", async () => {
    const abuse = abuseGuardService();
    const middleware = new RawArchiveBodyMiddleware(configService(), abuse, drainState());
    const req = new FakeRequest();
    req.headers["content-length"] = "1";
    const res = fakeResponse();
    const next = jest.fn();

    await middleware.use(req as unknown as Request, res, next);
    req.emit("data", Buffer.from("x"));
    req.emit("end");

    expect(abuse.checkAbuseFailOpen).toHaveBeenCalledWith(
      req,
      UPLOAD_SOURCE_ROUTE,
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });

  it("proceeds normally when checkAbuseFailOpen resolves allowed: true", async () => {
    const middleware = new RawArchiveBodyMiddleware(
      configService(),
      abuseGuardService({ allowed: true }),
      drainState(),
    );
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

  it("rejects before reading any body when Content-Length already exceeds the ceiling, without touching the DB-backed abuse check", async () => {
    const abuse = abuseGuardService();
    const middleware = new RawArchiveBodyMiddleware(configService(), abuse, drainState());
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
    res.emitFinish();
    expect(req.destroy).toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
    expect(abuse.checkAbuseFailOpen).not.toHaveBeenCalled();

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
    res.emitFinish();
    expect(req.destroy).toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it("rejects only once when multiple chunks each push size past the ceiling before destroy() takes effect", async () => {
    const middleware = new RawArchiveBodyMiddleware(configService(), abuseGuardService(), drainState());
    const req = new FakeRequest();
    const res = fakeResponse();
    const next = jest.fn();

    await middleware.use(req as unknown as Request, res, next);
    req.emit("data", Buffer.alloc(MAX_BYTES + 1));
    req.emit("data", Buffer.alloc(MAX_BYTES + 1));
    req.emit("end");

    expect(res.status).toHaveBeenCalledTimes(1);
    expect(res.json).toHaveBeenCalledTimes(1);
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

  it("does not preallocate the full ceiling for a request with no Content-Length", async () => {
    const bigCeiling = 50 * 1024 * 1024;
    const config = { get: () => bigCeiling } as unknown as ConstructorParameters<typeof RawArchiveBodyMiddleware>[0];
    const middleware = new RawArchiveBodyMiddleware(config, abuseGuardService(), drainState());
    const req = new FakeRequest();
    const res = fakeResponse();
    const next = jest.fn();
    const allocSpy = jest.spyOn(Buffer, "allocUnsafe");

    try {
      await middleware.use(req as unknown as Request, res, next);
      req.emit("data", Buffer.from("abc"));
      req.emit("end");

      expect(allocSpy.mock.calls[0]?.[0]).toBeLessThan(bigCeiling);
      expect((req as unknown as { body: Buffer }).body).toEqual(Buffer.from("abc"));
    } finally {
      allocSpy.mockRestore();
    }
  });

  it("grows the buffer and keeps the full body when actual bytes outgrow an understated Content-Length", async () => {
    const middleware = new RawArchiveBodyMiddleware(configService(), abuseGuardService(), drainState());
    const req = new FakeRequest();
    req.headers["content-length"] = "2";
    const res = fakeResponse();
    const next = jest.fn();

    await middleware.use(req as unknown as Request, res, next);
    req.emit("data", Buffer.from("ab"));
    req.emit("data", Buffer.from("cdefgh"));
    req.emit("end");

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
    expect((req as unknown as { body: Buffer }).body).toEqual(Buffer.from("abcdefgh"));
  });
});
