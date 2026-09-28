import { Inject, Injectable } from "@nestjs/common";
import { TrustedVerifiersRepository } from "@scvs/db-query";
import { ScvsLogger } from "@scvs/core";
import {
  toTrustedVerifier,
  TRUSTED_VERIFIERS_LIST_SCHEMA,
  TRUSTED_VERIFIERS_LIST_SCHEMA_VERSION,
} from "../../common/tvl.js";

@Injectable()
export class VerifiersService {
  private readonly logger = new ScvsLogger("verifiers");

  // Explicit `@Inject()`: tsx/esbuild emits no decorator metadata.
  constructor(
    @Inject(TrustedVerifiersRepository)
    private readonly verifiers: TrustedVerifiersRepository,
  ) {}

  async list() {
    const rows = await this.verifiers.listTrustedVerifiers();
    return {
      schema: TRUSTED_VERIFIERS_LIST_SCHEMA,
      schema_version: TRUSTED_VERIFIERS_LIST_SCHEMA_VERSION,
      verifiers: rows.flatMap((row) => {
        try {
          return [{ ...toTrustedVerifier(row), added_at: row.addedAt }];
        } catch (error) {
          this.logger.error("skipping malformed trusted_verifiers row", {
            verifier_id: row.verifierId,
            error: error instanceof Error ? error.message : String(error),
          });
          return [];
        }
      }),
      updated_at: new Date().toISOString(),
    };
  }
}
