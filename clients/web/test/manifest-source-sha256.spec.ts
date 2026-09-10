import { describe, expect, test } from "vitest";
import { buildInlineManifest } from "@/features/verification/utils/manifest.util";
import type { SourceUploadResponse, VerifyFormValues } from "@/features/verification/types";

/**
 * The console's own field rule is `/^[0-9a-f]{64}$/i`, so this is the last place the spelling can be fixed
 * before the request leaves — and the publish boundary accepts lowercase only.
 */
const UPPERCASE = "28A14827FA2B0E45D0A66E1E4C4A57A6F0E1F1B92BD9C4D5E6F708192A3B4C5D";
const LOWERCASE = UPPERCASE.toLowerCase();

const values = (over: Partial<VerifyFormValues>) =>
  ({ network: "testnet", targetType: "contract_id", contractId: "CABC", ...over }) as VerifyFormValues;

describe("the source hash a submission carries", () => {
  test("an uppercase paste reaches the request body lowercased", () => {
    expect(buildInlineManifest(values({ source_sha256: UPPERCASE })).source_sha256).toBe(LOWERCASE);
  });

  test("surrounding whitespace is still trimmed", () => {
    expect(buildInlineManifest(values({ source_sha256: `  ${UPPERCASE}\n` })).source_sha256).toBe(LOWERCASE);
  });

  test("an absent field stays absent — the optional-chain must not produce a string", () => {
    expect(buildInlineManifest(values({})).source_sha256).toBeUndefined();
  });

  test("an uploaded archive's own hash still wins over the typed field", () => {
    // Computed by the upload endpoint with `digest("hex")`, so already lowercase and the verifier's own fact
    // rather than a claim — this asserts the precedence, not the case.
    const uploaded: SourceUploadResponse = { upload_id: "u-1", source_sha256: "f".repeat(64) };
    expect(buildInlineManifest(values({ source_sha256: UPPERCASE }), uploaded).source_sha256).toBe("f".repeat(64));
  });
});
