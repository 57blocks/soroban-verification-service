import type { SourceReference } from "@scvs/core";
import type { FetchSourceConfig, MaterializeSourceInput } from "./fetch-source.js";

/** Maps a `SourceReference` onto `materializeSource`'s input union. */
export function toMaterializeSourceInput(
  sourceRef: SourceReference,
  config: FetchSourceConfig
): MaterializeSourceInput {
  switch (sourceRef.type) {
    case "git":
      return { sourceRef, config };
    case "hosted_tarball":
      return { sourceRef, config };
    case "private_tarball": {
      // services/orchestrator-svc resolves `upload_id` via its own `@scvs/db` access and must populate
      // `source_ref.source_uri` with the resolved location (local path or fetchable URL) before submitting the
      // Batch job.
      if (!sourceRef.source_uri) {
        throw new Error(
          "private_tarball source_ref is missing a resolved location: services/orchestrator-svc must resolve " +
            "upload_id via @scvs/db and populate source_ref.source_uri before submitting the Batch job."
        );
      }
      return { sourceRef, resolvedLocalPath: sourceRef.source_uri, config };
    }
    case "source_uri":
      return { sourceRef, resolvedLocalPath: sourceRef.source_uri, config };
  }
}
