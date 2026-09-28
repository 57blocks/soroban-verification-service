import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { SourceVisibilityRow } from "@/features/verification/components/SourceVisibilityRow";
import type { ArtifactRecipeFacts } from "@/features/verification/types";
import { buildInlineManifest } from "@/features/verification/utils/manifest.util";
import { defaultValues } from "@/features/verification/constants";

const SHA = "b".repeat(64);

const NO_RECIPE: ArtifactRecipeFacts = {
  recipeSource: null,
  buildIsolation: null,
  pair: null,
  environment: null,
  components: [],
  buildOptions: [],
  metadataReplay: [],
};

describe("non-public source is a legitimate outcome, not a missing one", () => {
  test("is never described as missing, absent, or unavailable", () => {
    render(
      <SourceVisibilityRow
        state={{ phase: "published", status: "verified", source: { isPublic: false, sourceSha256: SHA, fileName: null, sourceUri: null }, recipe: NO_RECIPE }}
      />,
    );

    const text = screen.getByTestId("source-visibility").textContent ?? "";
    expect(text).toMatch(/not public/i);
    expect(text).not.toMatch(/missing/i);
    expect(text).not.toMatch(/unavailable/i);
  });

  test("shows the source_sha256 commitment, which is what was verified", () => {
    render(
      <SourceVisibilityRow state={{ phase: "published", status: "verified", source: { isPublic: false, sourceSha256: SHA, fileName: null, sourceUri: null }, recipe: NO_RECIPE }} />,
    );

    expect(screen.getByText(new RegExp(SHA))).toBeInTheDocument();
  });

  test("public source says so, and names what was published", () => {
    render(
      <SourceVisibilityRow
        state={{ phase: "published", status: "verified", source: { isPublic: true, sourceSha256: SHA, fileName: `${SHA}.tar.gz`, sourceUri: null }, recipe: NO_RECIPE }}
      />,
    );

    const text = screen.getByTestId("source-visibility").textContent ?? "";
    expect(text).toMatch(/published/i);
    expect(text).toMatch(new RegExp(`${SHA}\\.tar\\.gz`));
  });

  test("an unreadable artifact is unknown, not private", () => {
    render(<SourceVisibilityRow state={{ phase: "unreadable", error: "boom" }} />);

    const text = screen.getByTestId("source-visibility").textContent ?? "";
    expect(text).toMatch(/not stated/i);
    expect(text).toMatch(/not the same as non-public/i);
  });
});

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
