import { jest } from "@jest/globals";
import { EventEmitter } from "node:events";
import type { Request, Response } from "express";
import { RawArchiveBodyMiddleware } from "../src/common/raw-archive-body.middleware.js";

const MAX_BYTES = 1024;

function configService() {
  return { get: () => MAX_BYTES } as unknown as ConstructorParameters<typeof RawArchiveBodyMiddleware>[0];
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
  it("rejects before reading any body when Content-Length already exceeds the ceiling", () => {
    const middleware = new RawArchiveBodyMiddleware(configService());
    const req = new FakeRequest();
    req.headers["content-length"] = String(MAX_BYTES + 1);
    const res = fakeResponse();
    const next = jest.fn();
    const dataListener = jest.fn();
    req.on("data", dataListener);

    middleware.use(req as unknown as Request, res, next);

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

  it("accepts a request with no Content-Length and falls back to the per-chunk ceiling", () => {
    const middleware = new RawArchiveBodyMiddleware(configService());
    const req = new FakeRequest();
    const res = fakeResponse();
    const next = jest.fn();

    middleware.use(req as unknown as Request, res, next);
    req.emit("data", Buffer.alloc(MAX_BYTES + 1));

    expect(res.status).toHaveBeenCalledWith(413);
    expect(req.destroy).toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it("buffers chunks and calls next() with the assembled body when under the ceiling", () => {
    const middleware = new RawArchiveBodyMiddleware(configService());
    const req = new FakeRequest();
    req.headers["content-length"] = "6";
    const res = fakeResponse();
    const next = jest.fn();

    middleware.use(req as unknown as Request, res, next);
    req.emit("data", Buffer.from("abc"));
    req.emit("data", Buffer.from("def"));
    req.emit("end");

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
    expect((req as unknown as { body: Buffer }).body).toEqual(Buffer.from("abcdef"));
  });
});
