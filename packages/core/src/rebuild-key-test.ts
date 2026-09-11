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

// --- metadata_replay isolation -------------------------------------------------------------
// Replaying a contract's recorded metadata changes the bytes that come out, so two recipes differing only there
// must not share a compile.

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

// An empty metadata_replay is the same recipe as an absent one — it is what makes a recipe with no replay hash
// to exactly the four-field digest an independent implementation would compute.
assert.equal(
  computeIdempotencyKey(source, image, {
    bldarg: ["contract", "build"],
    bldopt: ["--locked"],
    metadata_replay: [],
  }),
  withoutMetadata,
);

// --- K4: length-prefixed encoding ----------------------------------------------------------
// The property length prefixing exists for: no two distinct tuples serialise to the same bytes, so a separator
// appearing INSIDE a build flag cannot forge a collision with a different tuple.

assert.notEqual(
  computeIdempotencyKey(source, image, { bldopt: ["a:b", "c"] }),
  computeIdempotencyKey(source, image, { bldopt: ["a", "b:c"] }),
);
assert.notEqual(
  computeIdempotencyKey(source, image, { bldopt: ["1:x"] }),
  computeIdempotencyKey(source, image, { bldopt: ["x"] }),
);
// The same character count either side of the field boundary, so only the prefix distinguishes them.
assert.notEqual(
  computeIdempotencyKey(source, "ab", { bldopt: ["c"] }),
  computeIdempotencyKey(source, "abc", { bldopt: [] }),
);

// --- K4: the digest is fixed, so a second implementation can be checked against it -----------
// This is the whole point of specifying an encoding rather than "hash the fields".
assert.equal(
  computeIdempotencyKey(source, image, { bldarg: ["contract", "build"], bldopt: ["--locked"] }),
  "b4e66f58ff464d54c465b02e33ef500d23db65c4ac1065f420f4dbb49b1e8e6b",
);

// --- K2: bldopt order is not significant ----------------------------------------------------

assert.equal(
  computeIdempotencyKey(source, image, { bldopt: ["--features", "x", "--release"] }),
  computeIdempotencyKey(source, image, { bldopt: ["--release", "--features", "x"] }),
);

// Bytewise, not UTF-16 code-unit order — the two disagree above U+FFFF.
assert.equal(
  computeIdempotencyKey(source, image, { bldopt: ["\u{1F600}", "＀"] }),
  computeIdempotencyKey(source, image, { bldopt: ["＀", "\u{1F600}"] }),
);
// And the sort is actually bytewise: hashing the pair in UTF-16 order (U+1F600 first, because its surrogate
// pair starts at 0xD83D) must NOT produce the same key as the bytewise order the encoding is defined in.
assert.notEqual(
  computeIdempotencyKey(source, image, { bldarg: ["\u{1F600}", "＀"] }),
  computeIdempotencyKey(source, image, { bldarg: ["＀", "\u{1F600}"] }),
);
// The bytewise winner is U+FF00 first, which is what `bldopt` must normalise to whichever way it was given.
assert.equal(
  computeIdempotencyKey(source, image, { bldarg: [], bldopt: ["\u{1F600}", "＀"] }),
  computeIdempotencyKey(source, image, { bldarg: [], bldopt: ["＀", "\u{1F600}"] }),
);

// --- K4: bldarg order IS significant, and an absent one takes SEP-58's default ----------------

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

// --- K1: keyed on content, never on location -------------------------------------------------

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

// A tarball ref keys on its archive hash, which IS the content hash — the same bytes uploaded privately and
// fetched from a URL are the same recipe.
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

// A git ref with no content hash is a location, not a recipe: {repo, rev} can be re-pointed under us, so keying
// on it would let two different sources share one compile.
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

// --- K3: nothing target-shaped enters the key ------------------------------------------------
// The signature takes no target, so the only way this breaks is someone adding one.

assert.equal(computeIdempotencyKey.length, 3);

console.log("Rebuild key: encoding, K1–K4 and metadata_replay isolation — all cases passed");
