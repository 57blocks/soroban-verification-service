import { Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { getVerifierIdentity } from "@scvs/config";
import {
  ERROR_SCHEMA,
  ERROR_SCHEMA_VERSION,
  errorEnvelope,
  parseStrictRegistryStatusObject,
  REGISTRY_SCHEMA,
  REGISTRY_SCHEMA_VERSION,
  ScvsLogger,
  SEP58_HEX_SHA256,
  type RegistryStatusObject,
} from "@scvs/core";
import { JobsRepository } from "@scvs/db";
import { createResultStorage, wasmStatusKey, type ResultStorage } from "@scvs/storage-layout";
import type { AppConfigService } from "../../config/configuration.js";

/**
 * The route's error body: the SEP envelope without `status_code`, which these routes deliberately omit — so
 * `errorEnvelope()` and not verification-svc's `errorBody()`. The code is a literal because SEP §4 closes the
 * vocabulary per status.
 */
type RegistryErrorBody<Code extends string> = {
  schema: typeof ERROR_SCHEMA;
  schema_version: typeof ERROR_SCHEMA_VERSION;
  error: Code;
  message: string;
};

function registryError<Code extends string>(error: Code, message: string): RegistryErrorBody<Code> {
  return { ...errorEnvelope({ error, message }), error };
}

/** The bodies `GET /api/verification/v1/wasms/{wasm_hash}.json` can answer with, one variant per status code. */
export type WasmStatusResponse =
  | { statusCode: 400; body: RegistryErrorBody<"400_invalid_wasm_hash"> }
  | { statusCode: 202; body: RegistryStatusObject }
  | { statusCode: 200; text: string }
  | { statusCode: 404; body: RegistryErrorBody<"not_found"> }
  | { statusCode: 503; body: RegistryErrorBody<"storage_unavailable"> };

/** The one 503: a read that failed. A configuration that cannot be read is now a boot failure instead. */
const STORAGE_UNAVAILABLE = registryError("storage_unavailable", "Result storage is temporarily unreadable.");

@Injectable()
export class WasmsService {
  private readonly logger = new ScvsLogger("wasms-status");
  private readonly storage: ResultStorage;
  private readonly publicRoot: string;

  // Explicit `@Inject()` — see preflight.controller.ts's comment (tsx/esbuild doesn't emit the decorator
  // metadata Nest's DI would otherwise infer this parameter's type from).
  constructor(
    @Inject(JobsRepository) private readonly jobs: JobsRepository,
    @Inject(ConfigService) configService: AppConfigService,
  ) {
    const config = configService.get("resultStorage", { infer: true });
    this.storage = createResultStorage(config);
    this.publicRoot = config.publicRoot;
  }

  async get(wasmHashParam: string): Promise<WasmStatusResponse> {
    // Normalised the way the submit boundary (`@LowercaseHex`) and query-svc's aggregated route both normalise:
    // a block explorer shows uppercase hex, so a polling consumer may well send it.
    const wasmHash = wasmHashParam.toLowerCase();
    if (!SEP58_HEX_SHA256.test(wasmHash)) {
      // RC2's restricted set, in the SEP envelope.
      return {
        statusCode: 400,
        body: registryError("400_invalid_wasm_hash", "wasm_hash must be a lowercase-hex SHA-256."),
      };
    }

    // RC3's own precedence: `202` while a verification for this hash is queued or running.
    const active = await this.jobs.getActiveJobForWasmHash(wasmHash);
    if (active) {
      return { statusCode: 202, body: this.pendingStatusObject(wasmHash, active.updatedAt) };
    }

    let text: string | undefined;
    try {
      text = await this.storage.readText(wasmStatusKey(wasmHash));
    } catch (error) {
      this.logger.error("result-storage read failed for a wasm-status request", {
        wasm_hash: wasmHash,
        error: error instanceof Error ? error : String(error),
      });
      return { statusCode: 503, body: STORAGE_UNAVAILABLE };
    }
    if (text === undefined) {
      return { statusCode: 404, body: registryError("not_found", "No verification result for that Wasm hash.") };
    }

    // The raw bytes, not a re-serialised object.
    return { statusCode: 200, text };
  }

  /** The `202` body, valid against the same status object schema the `200` serves. */
  private pendingStatusObject(wasmHash: string, updatedAt: string): RegistryStatusObject {
    // SO3: an `unverified` entry is exactly {verifier, status} — no recipe, no custody, no timestamps.
    return parseStrictRegistryStatusObject({
      schema: REGISTRY_SCHEMA,
      schema_version: REGISTRY_SCHEMA_VERSION,
      wasm_hash: wasmHash,
      updated_at: updatedAt,
      source_code_verifications: [
        {
          verifier: { name: getVerifierIdentity().displayName, url: this.publicRoot },
          status: "unverified",
        },
      ],
    });
  }
}
