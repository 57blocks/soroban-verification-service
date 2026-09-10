import { ApiProperty } from "@nestjs/swagger";
import { ERROR_SCHEMA, ERROR_SCHEMA_VERSION } from "@scvs/core";

/**
 * The per-hash read route's error body: the Results SEP envelope minus `status_code`, an omission that is a
 * property of this route rather than of the document type. `error` is closed per **status**, not per route
 * (SEP §4), so each status names its own code in the subclasses below.
 */
abstract class RegistryErrorBody {
  @ApiProperty({ enum: [ERROR_SCHEMA] })
  schema!: string;

  @ApiProperty({ enum: [ERROR_SCHEMA_VERSION] })
  schema_version!: string;

  @ApiProperty({ type: String, description: "Human-readable; wording is not stable." })
  message!: string;
}

/** The `400`: the one closed vocabulary in the SEP, inherited from the Registry API draft (RC2). */
export class RegistryErrorResponse extends RegistryErrorBody {
  @ApiProperty({
    enum: ["400_invalid_wasm_hash", "400_other"],
    description: "A stable, machine-readable error code from the restricted set RC2 names for this status.",
  })
  error!: string;
}

export class RegistryNotFoundResponse extends RegistryErrorBody {
  @ApiProperty({ enum: ["not_found"] })
  error!: string;
}

export class RegistryStorageUnavailableResponse extends RegistryErrorBody {
  @ApiProperty({ enum: ["storage_unavailable"] })
  error!: string;
}
