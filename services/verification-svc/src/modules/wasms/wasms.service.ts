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

type RegistryErrorBody<Code extends string> = {
  schema: typeof ERROR_SCHEMA;
  schema_version: typeof ERROR_SCHEMA_VERSION;
  error: Code;
  message: string;
};

function registryError<Code extends string>(error: Code, message: string): RegistryErrorBody<Code> {
  return { ...errorEnvelope({ error, message }), error };
}

export type WasmStatusResponse =
  | { statusCode: 400; body: RegistryErrorBody<"400_invalid_wasm_hash"> }
  | { statusCode: 202; body: RegistryStatusObject }
  | { statusCode: 200; text: string }
  | { statusCode: 404; body: RegistryErrorBody<"not_found"> }
  | { statusCode: 503; body: RegistryErrorBody<"storage_unavailable"> };

const STORAGE_UNAVAILABLE = registryError("storage_unavailable", "Result storage is temporarily unreadable.");

@Injectable()
export class WasmsService {
  private readonly logger = new ScvsLogger("wasms-status");
  private readonly storage: ResultStorage;
  private readonly publicRoot: string;

  constructor(
    @Inject(JobsRepository) private readonly jobs: JobsRepository,
    @Inject(ConfigService) configService: AppConfigService,
  ) {
    const config = configService.get("resultStorage", { infer: true });
    this.storage = createResultStorage(config);
    this.publicRoot = config.publicRoot;
  }

  async get(wasmHashParam: string): Promise<WasmStatusResponse> {
    const wasmHash = wasmHashParam.toLowerCase();
    if (!SEP58_HEX_SHA256.test(wasmHash)) {
      return {
        statusCode: 400,
        body: registryError("400_invalid_wasm_hash", "wasm_hash must be a lowercase-hex SHA-256."),
      };
    }

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

    return { statusCode: 200, text };
  }

  private pendingStatusObject(wasmHash: string, updatedAt: string): RegistryStatusObject {
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
