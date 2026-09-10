/** The required-evidence rules for stage two, as refusal messages. */

/** Required — nothing else identifies the bytes being claimed. */
export const sourceSha256Refusal = (value?: string): string | null => {
  const trimmed = value?.trim();
  if (!trimmed) return "Enter the source archive SHA-256";
  return /^[0-9a-f]{64}$/i.test(trimmed)
    ? null
    : "Must be a 64-character hex string";
};

/**
 * `SOURCE_URI_PATTERN` (`packages/core/src/registry.ts`) is the authority and is deliberately copied rather
 * than imported.
 */
const SOURCE_URI_PATTERN = /^(?:[a-zA-Z][a-zA-Z0-9+.-]*:\S+|\/\S+)$/;

/**
 * Required on the `public_uri` path and only there: `buildInlineManifest` omits `upload_id` on that path, so
 * this field is the whole answer to "where are the bytes".
 */
export const sourceUriRefusal = (value?: string): string | null => {
  // Trimmed first because that is what `buildInlineManifest` submits — judging the untrimmed value would refuse
  // input the API would have accepted.
  const trimmed = value?.trim();
  if (!trimmed) {
    return "Enter the public URL of the exact source archive, or switch to Upload archive.";
  }
  return SOURCE_URI_PATTERN.test(trimmed)
    ? null
    : "Must be a full URI, e.g. https://example.com/my-contract-v1.0.0.tar.gz";
};
