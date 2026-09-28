import assert from "node:assert/strict";
import { computeIdempotencyKey } from "./rebuild-key.js";
import type { SourceReference } from "./source.js";

const source: SourceReference = {
  type: "source_uri",
  visibility: "public",
  source_uri: "https://example.com/source.tar.gz",
  source_sha256: "a".repeat(64),
};
const image = "docker.io/stellar/stellar-cli@sha256:" + "b".repeat(64);

const withoutMetadata = computeIdempotencyKey(source, image, {
  bldarg: ["contract", "build"],
  bldopt: ["--locked"],
});
const withMetadataA = computeIdempotencyKey(source, image, {
  bldarg: ["contract", "build"],
  bldopt: ["--locked"],
  metadata_replay: ["home_domain=a.example"],
});
const withMetadataB = computeIdempotencyKey(source, image, {
  bldarg: ["contract", "build"],
  bldopt: ["--locked"],
  metadata_replay: ["home_domain=b.example"],
});

assert.notEqual(withoutMetadata, withMetadataA);
assert.notEqual(withMetadataA, withMetadataB);

assert.equal(
  computeIdempotencyKey(source, image, {
    bldarg: ["contract", "build"],
    bldopt: ["--locked"],
    metadata_replay: [],
  }),
  withoutMetadata,
);

assert.notEqual(
  computeIdempotencyKey(source, image, { bldopt: ["a:b", "c"] }),
  computeIdempotencyKey(source, image, { bldopt: ["a", "b:c"] }),
);
assert.notEqual(
  computeIdempotencyKey(source, image, { bldopt: ["1:x"] }),
  computeIdempotencyKey(source, image, { bldopt: ["x"] }),
);
assert.notEqual(
  computeIdempotencyKey(source, "ab", { bldopt: ["c"] }),
  computeIdempotencyKey(source, "abc", { bldopt: [] }),
);

assert.equal(
  computeIdempotencyKey(source, image, { bldarg: ["contract", "build"], bldopt: ["--locked"] }),
  "b4e66f58ff464d54c465b02e33ef500d23db65c4ac1065f420f4dbb49b1e8e6b",
);

assert.equal(
  computeIdempotencyKey(source, image, { bldopt: ["--features", "x", "--release"] }),
  computeIdempotencyKey(source, image, { bldopt: ["--release", "--features", "x"] }),
);

assert.equal(
  computeIdempotencyKey(source, image, { bldopt: ["\u{1F600}", "＀"] }),
  computeIdempotencyKey(source, image, { bldopt: ["＀", "\u{1F600}"] }),
);
assert.notEqual(
  computeIdempotencyKey(source, image, { bldarg: ["\u{1F600}", "＀"] }),
  computeIdempotencyKey(source, image, { bldarg: ["＀", "\u{1F600}"] }),
);
assert.equal(
  computeIdempotencyKey(source, image, { bldarg: [], bldopt: ["\u{1F600}", "＀"] }),
  computeIdempotencyKey(source, image, { bldarg: [], bldopt: ["＀", "\u{1F600}"] }),
);

assert.notEqual(
  computeIdempotencyKey(source, image, { bldarg: ["contract", "build"] }),
  computeIdempotencyKey(source, image, { bldarg: ["build", "contract"] }),
);

const bldargDefault = computeIdempotencyKey(source, image, { bldopt: ["--locked"] });
assert.equal(
  computeIdempotencyKey(source, image, { bldarg: [], bldopt: ["--locked"] }),
  bldargDefault,
);
assert.equal(
  computeIdempotencyKey(source, image, { bldarg: ["contract", "build"], bldopt: ["--locked"] }),
  bldargDefault,
);

const sameBytesOtherUrl: SourceReference = {
  ...source,
  source_uri: "https://mirror.example.net/other-name.tar.gz",
};
assert.equal(
  computeIdempotencyKey(sameBytesOtherUrl, image, { bldopt: [] }),
  computeIdempotencyKey(source, image, { bldopt: [] }),
);

const correctedContentSameUrl: SourceReference = { ...source, source_sha256: "c".repeat(64) };
assert.notEqual(
  computeIdempotencyKey(correctedContentSameUrl, image, { bldopt: [] }),
  computeIdempotencyKey(source, image, { bldopt: [] }),
);

const privateTarball: SourceReference = {
  type: "private_tarball",
  visibility: "private",
  tarball_sha256: "a".repeat(64),
  upload_id: "11111111-1111-1111-1111-111111111111",
};
const sameTarballDifferentUpload: SourceReference = {
  ...privateTarball,
  upload_id: "22222222-2222-2222-2222-222222222222",
};
assert.equal(
  computeIdempotencyKey(privateTarball, image, { bldopt: [] }),
  computeIdempotencyKey(sameTarballDifferentUpload, image, { bldopt: [] }),
);

assert.throws(
  () =>
    computeIdempotencyKey(
      { type: "git", visibility: "public", repo: "https://github.com/x/y", rev: "v1.0.0" },
      image,
      { bldopt: [] },
    ),
  /source_sha256/,
);
assert.doesNotThrow(() =>
  computeIdempotencyKey(
    {
      type: "git",
      visibility: "public",
      repo: "https://github.com/x/y",
      rev: "v1.0.0",
      source_sha256: "a".repeat(64),
    },
    image,
    { bldopt: [] },
  ),
);

assert.equal(computeIdempotencyKey.length, 3);

console.log("Rebuild key: encoding, K1–K4 and metadata_replay isolation — all cases passed");
