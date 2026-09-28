import type { Server } from "node:http";
import { gzipSync } from "node:zlib";
import request from "supertest";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { ACCEPTED_UPLOAD_ARCHIVE_SUFFIXES, uploadArchiveFormat } from "@scvs/core";
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

const upload = (body: Buffer, filename = "source.tar.gz") =>
  request(server)
    .post("/api/verification/v1/uploads/source")
    .set("content-type", "application/gzip")
    .set("x-filename", filename)
    .send(body);

describe("POST /v1/uploads/source admits gzip and zip", () => {
  it("refuses a bare tar — readable by the build path, not admitted here", async () => {
    const tar = Buffer.alloc(1024);
    tar.write("ustar", 257, "latin1");

    const res = await upload(tar, "counter.tar");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("source_archive_format_unsupported");
    expect(res.body.message).toContain(ACCEPTED_UPLOAD_ARCHIVE_SUFFIXES[0]);
    expect(res.body.schema_version).toBe("1.0");
  });

  it("refuses gzip-named bytes that are neither gzip nor zip", async () => {
    expect((await upload(Buffer.from("not really a tarball"))).body.error).toBe(
      "source_archive_format_unsupported",
    );
  });

  it("refuses a one-byte body", async () => {
    expect((await upload(Buffer.from([0x1f]))).body.error).toBe("source_archive_format_unsupported");
  });

  it("still answers invalid_upload for an empty body", async () => {
    const res = await request(server)
      .post("/api/verification/v1/uploads/source")
      .set("content-type", "application/gzip")
      .send();

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_upload");
  });

  it("admits a gzip tarball", () => {
    expect(uploadArchiveFormat(gzipSync(Buffer.alloc(512)))).toBe("gzip");
  });

  it("admits a zip — what Finder's Compress produces from an archive, and a zipped project folder", () => {
    const zip = Buffer.concat([Buffer.from("PK\x03\x04", "latin1"), Buffer.alloc(64)]);
    expect(uploadArchiveFormat(zip)).toBe("zip");
  });

  it("still judges the bytes and never the filename", () => {
    expect(uploadArchiveFormat(Buffer.from("PK not really a zip"))).toBeUndefined();
    expect(uploadArchiveFormat(Buffer.from("\x1f not really gzip"))).toBeUndefined();
  });
});
