import {
  TrustedVerifiersRepository,
  type TrustedVerifierRecord,
} from "@scvs/db-query";
import { ScvsLogger } from "@scvs/core";
import {
  TRUSTED_VERIFIERS_LIST_SCHEMA,
  TRUSTED_VERIFIERS_LIST_SCHEMA_VERSION,
  trustedVerifierStatuses,
} from "@scvs/storage-layout/shapes";
import type { TrustedVerifier, TrustedVerifiersList } from "@scvs/sdk";

export { TRUSTED_VERIFIERS_LIST_SCHEMA, TRUSTED_VERIFIERS_LIST_SCHEMA_VERSION };

const logger = new ScvsLogger("tvl");

/**
 * The list comes from `@scvs/db-query`'s `trusted_verifiers` table (seeded from the document
 * `SCVS_TRUSTED_VERIFIERS_SOURCE` names via scripts/seed-tvl.ts), not a static hosted URL, and maps straight
 * into the object `newClient` takes.
 */
export function toTrustedVerifier(
  record: TrustedVerifierRecord
): TrustedVerifier {
  const status = record.status as TrustedVerifier["status"];
  if (!trustedVerifierStatuses.includes(status)) {
    throw new Error(
      `trusted_verifiers row "${record.verifierId}" has status "${record.status}", which is not one ` +
        `of ${trustedVerifierStatuses.join(" | ")}`,
    );
  }

  if (record.bulkLoadUrl === undefined) {
    // A row missing it is malformed the same way an unrecognised status is.
    throw new Error(
      `trusted_verifiers row "${record.verifierId}" has no bulk_load_url; static-only TVL membership ` +
        `is not supported`,
    );
  }

  return {
    id: record.verifierId,
    display_name: record.displayName ?? record.verifierId,
    url: record.resultsRoot,
    manifest_url: record.manifestUrl,
    trust_tier: record.trustTier,
    status,
    bulk_load_url: record.bulkLoadUrl,
  };
}

/** Loads the Trusted Verifiers List this instance aggregates across. */
export async function loadTrustedVerifiersList(
  verifiers: TrustedVerifiersRepository,
  opts: { activeOnly?: boolean } = {}
): Promise<TrustedVerifiersList> {
  const rows = await verifiers.listTrustedVerifiers(opts);
  return {
    schema: TRUSTED_VERIFIERS_LIST_SCHEMA,
    schema_version: TRUSTED_VERIFIERS_LIST_SCHEMA_VERSION,
    // One bad row must not take down every other verifier's presence in the list a caller builds from this.
    verifiers: rows.flatMap((row) => {
      try {
        return [toTrustedVerifier(row)];
      } catch (error) {
        logger.error("skipping malformed trusted_verifiers row", {
          verifier_id: row.verifierId,
          error: error instanceof Error ? error.message : String(error),
        });
        return [];
      }
    }),
    updated_at: new Date().toISOString(),
  };
}

export type { TrustedVerifierRecord };
