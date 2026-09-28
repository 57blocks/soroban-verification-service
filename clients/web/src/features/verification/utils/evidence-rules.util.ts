import { HEX_SHA256_ANY_CASE, SOURCE_URI_PATTERN } from "@/lib/field-shapes";

export const sourceSha256Refusal = (value?: string): string | null => {
  const trimmed = value?.trim();
  if (!trimmed) return "Enter the source archive SHA-256";
  return HEX_SHA256_ANY_CASE.test(trimmed)
    ? null
    : "Must be a 64-character hex string";
};

export const sourceUriRefusal = (value?: string): string | null => {
  const trimmed = value?.trim();
  if (!trimmed) {
    return "Enter the public URL of the exact source archive, or switch to Upload archive.";
  }
  return SOURCE_URI_PATTERN.test(trimmed)
    ? null
    : "Must be a full URI, e.g. https://example.com/my-contract-v1.0.0.tar.gz";
};
