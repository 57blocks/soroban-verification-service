import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResultStorageConfig } from "./storage-backend.js";

/** Throws rather than returning an unusable config, so a bad environment stops the process at boot. */
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
