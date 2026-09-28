import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import {
  ARCHIVE_HEAD_BYTES,
  UPLOAD_ARCHIVE_CONTENT_TYPE,
  UPLOAD_ARCHIVE_DEFAULT_SUFFIX,
  sniffArchiveFormatFromHead,
  uploadArchiveFormat,
} from "./archive-format.js";
import { ACCEPTED_UPLOAD_ARCHIVE_SUFFIXES } from "./source.js";

function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

function ustarHead(): Uint8Array {
  const head = Buffer.alloc(ARCHIVE_HEAD_BYTES);
  head.write("ustar", 257, "latin1");
  return head;
}

const zipHead = (kind: [number, number]) => Uint8Array.from([0x50, 0x4b, ...kind]);

test("gzip, from its magic number", () => {
  assert.equal(sniffArchiveFormatFromHead(gzipSync(Buffer.from("x"))), "gzip");
});

test("all three zip signatures — local file header, empty, spanned", () => {
  assert.equal(sniffArchiveFormatFromHead(zipHead([0x03, 0x04])), "zip");
  assert.equal(sniffArchiveFormatFromHead(zipHead([0x05, 0x06])), "zip");
  assert.equal(sniffArchiveFormatFromHead(zipHead([0x07, 0x08])), "zip");
});

test("`PK` followed by something else is not a zip", () => {
  assert.equal(sniffArchiveFormatFromHead(zipHead([0x01, 0x02])), "unknown");
});

test("bare tar, from the marker at offset 257", () => {
  assert.equal(sniffArchiveFormatFromHead(ustarHead()), "tar");
});

test("a buffer too short to carry a marker is unknown, never a throw", () => {
  assert.equal(sniffArchiveFormatFromHead(new Uint8Array()), "unknown");
  assert.equal(sniffArchiveFormatFromHead(Uint8Array.from([0x1f])), "unknown");
  assert.equal(sniffArchiveFormatFromHead(ustarHead().subarray(0, 261)), "unknown");
});

test("the upload door's predicate is this table, not a second copy of it", () => {
  assert.equal(uploadArchiveFormat(gzipSync(Buffer.from("x"))), "gzip");
  assert.equal(uploadArchiveFormat(zipHead([0x03, 0x04])), "zip");
  assert.equal(uploadArchiveFormat(Uint8Array.from([0x1f])), undefined);
});

test("a bare tar is refused at the door and still read by the build path", () => {
  assert.equal(sniffArchiveFormatFromHead(ustarHead()), "tar");
  assert.equal(uploadArchiveFormat(ustarHead()), undefined);
});

test("every admitted format has a name, a content type and a default suffix", () => {
  for (const format of ["gzip", "zip"] as const) {
    assert.ok(UPLOAD_ARCHIVE_CONTENT_TYPE[format], `no content type for ${format}`);
    const suffix = UPLOAD_ARCHIVE_DEFAULT_SUFFIX[format];
    assert.ok(
      (ACCEPTED_UPLOAD_ARCHIVE_SUFFIXES as readonly string[]).includes(suffix),
      `default suffix ${suffix} is not one the door names`,
    );
  }
});
