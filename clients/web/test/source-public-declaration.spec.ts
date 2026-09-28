import { describe, expect, test } from "vitest";
import { buildInlineManifest } from "@/features/verification/utils/manifest.util";
import { defaultValues } from "@/features/verification/constants";

const SHA = "b".repeat(64);

describe("the public declaration is declared, never inferred", () => {
  test("defaults to not public", () => {
    expect(defaultValues.is_public).toBe(false);
    expect(buildInlineManifest({ ...defaultValues }).is_public).toBe(false);
  });

  test("an uploaded archive can still be declared public", () => {
    const manifest = buildInlineManifest(
      { ...defaultValues, is_public: true },
      { upload_id: "u-1", source_sha256: SHA },
      "upload_archive",
    );

    expect(manifest.is_public).toBe(true);
    expect(manifest.upload_id).toBe("u-1");
  });

  test("a public URI can still be declared not public", () => {
    const manifest = buildInlineManifest(
      { ...defaultValues, is_public: false, source_uri: "https://example.org/src.tar.gz", source_sha256: SHA },
      undefined,
      "public_uri",
    );

    expect(manifest.is_public).toBe(false);
    expect(manifest.source_uri).toBe("https://example.org/src.tar.gz");
  });
});
