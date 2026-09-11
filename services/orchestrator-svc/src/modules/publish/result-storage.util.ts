import type { ResultStorageConfig } from "@scvs/config";
import { createResultStorage, type ResultStorage } from "@scvs/storage-layout";

export function buildResultStorage(config: ResultStorageConfig): ResultStorage {
  if (config.kind === "filesystem") {
    return createResultStorage({ kind: "filesystem", root: config.localRoot!, publicRoot: config.publicRoot });
  }
  if (config.kind === "gcs") {
    throw new Error("SCVS_PUBLISHER_STORAGE=gcs is reserved for a future object-storage adapter. Use filesystem or r2.");
  }
  if (!config.bucket) {
    throw new Error(`SCVS_PUBLISHER_STORAGE=${config.kind} requires SCVS_PUBLISHER_BUCKET.`);
  }
  return createResultStorage({
    kind: config.kind,
    bucket: config.bucket,
    publicRoot: config.publicRoot,
    prefix: config.prefix,
    endpoint: config.endpoint,
    region: config.region,
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    forcePathStyle: config.forcePathStyle,
  });
}
