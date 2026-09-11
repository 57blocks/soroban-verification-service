import type { Server } from "node:http";
import { gzipSync } from "node:zlib";
import request from "supertest";
import { ACCEPTED_UPLOAD_ARCHIVE_SUFFIXES, uploadArchiveFormat } from "@scvs/core";
import { createTestServer } from "./bootstrap.js";

let server: Server;
beforeAll(async () => {
  server = await createTestServer();
});

const upload = (body: Buffer, filename = "source.tar.gz") =>
  request(server)
    .post("/api/verification/v1/uploads/source")
    .set("content-type", "application/gzip")
    .set("x-filename", filename)
    .send(body);

/** The door admits two archive formats, and refuses everything else from the bytes. */
describe("POST /v1/uploads/source admits gzip and zip", () => {
  it("refuses a bare tar — readable by the build path, not admitted here", async () => {
    // So the door is narrower than the extractor by construction, not by omission.
    const tar = Buffer.alloc(1024);
    tar.write("ustar", 257, "latin1");

    const res = await upload(tar, "counter.tar");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("source_archive_format_unsupported");
    expect(res.body.message).toContain(ACCEPTED_UPLOAD_ARCHIVE_SUFFIXES[0]);
    expect(res.body.schema_version).toBe("1.0");
  });

  // The filename is not the decision: the CLI reads a format off its name and that is the trap this service
  // exists downstream of (archive-format.ts).
  it("refuses gzip-named bytes that are neither gzip nor zip", async () => {
    expect((await upload(Buffer.from("not really a tarball"))).body.error).toBe(
      "source_archive_format_unsupported",
    );
  });

  // Shorter than any magic number, so the sniffer cannot say yes — and a body it cannot say yes about is
  // refused rather than staged.
  it("refuses a one-byte body", async () => {
    expect((await upload(Buffer.from([0x1f]))).body.error).toBe("source_archive_format_unsupported");
  });

  // Unchanged, and a different answer: "you sent nothing" says more than "that is not gzip".
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

  /**
   * Peeling a container to the archive inside it, and rebuilding an archive from a submitted tree only when it
   * hashes to the chain-recorded value, are what removed that reason.
   */
  it("admits a zip — what Finder's Compress produces from an archive, and a zipped project folder", () => {
    const zip = Buffer.concat([Buffer.from("PK\x03\x04", "latin1"), Buffer.alloc(64)]);
    expect(uploadArchiveFormat(zip)).toBe("zip");
  });

  it("still judges the bytes and never the filename", () => {
    // The trap this whole area sits downstream of: `stellar contract verify` reads a format off a
    // submitter-controlled name.
    expect(uploadArchiveFormat(Buffer.from("PK not really a zip"))).toBeUndefined();
    expect(uploadArchiveFormat(Buffer.from("\x1f not really gzip"))).toBeUndefined();
  });
});
