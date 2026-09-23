import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResultStorageConfig } from "./storage-backend.js";

/**
 * Reads the result-storage environment into the exact shape `createResultStorage` takes.
 *
 * It lives beside that function rather than in `@scvs/config` because the two used to be different shapes —
 * a flat all-optional record there, a discriminated union here — and each service carried its own translator
 * between them, reached for with `config.localRoot!`. One of the two translators threw on an unusable config
 * and the other logged and disabled reads, so the same environment produced two different failures.
 *
 * **It throws rather than returning something unusable.** Every caller reads it once at load, so a
 * configuration that cannot serve a single request stops the process at boot instead of at first use.
 */
export function resultStorageConfigFromEnv(): ResultStorageConfig {
  const kind = (process.env.SCVS_PUBLISHER_STORAGE || "filesystem").toLowerCase();
  const publicRoot = (process.env.SCVS_PUBLIC_RESULT_ROOT || "http://localhost:5000/public").replace(/\/+$/, "");

  if (kind === "filesystem") {
    const root =
      process.env.SCVS_RESULT_ROOT ||
      join(process.env.SCVS_ARTIFACT_DIR || join(tmpdir(), "scvs-artifacts"), "public");
    return { kind, root, publicRoot };
  }

  if (kind !== "s3" && kind !== "r2") {
    throw new Error(
      `SCVS_PUBLISHER_STORAGE=${kind} has no backend. Use filesystem, s3 or r2.`,
    );
  }

  const bucket = process.env.SCVS_PUBLISHER_BUCKET;
  if (!bucket) {
    throw new Error(`SCVS_PUBLISHER_STORAGE=${kind} requires SCVS_PUBLISHER_BUCKET.`);
  }

  // `endpoint` comes from the R2 variables for both object kinds: an AWS S3 deployment leaves them unset and
  // gets the SDK's own regional endpoint.
  const endpoint =
    process.env.SCVS_R2_ENDPOINT ||
    (process.env.SCVS_R2_ACCOUNT_ID
      ? `https://${process.env.SCVS_R2_ACCOUNT_ID}.r2.cloudflarestorage.com`
      : undefined);

  return {
    kind,
    bucket,
    publicRoot,
    prefix: process.env.SCVS_PUBLISHER_PREFIX || "",
    endpoint,
    region: process.env.SCVS_R2_REGION || "auto",
    accessKeyId: process.env.SCVS_R2_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.SCVS_R2_SECRET_ACCESS_KEY || process.env.AWS_SECRET_ACCESS_KEY,
    forcePathStyle: true,
  };
}
