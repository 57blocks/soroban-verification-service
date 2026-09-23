import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Equals, IsNumber, IsOptional, IsString } from "class-validator";
import { ERROR_SCHEMA, ERROR_SCHEMA_VERSION } from "./api-error.js";

/** What the document claimed instead was `SubmitErrorResponse`, a **200** variant nothing could produce. */
export class ApiErrorResponse {
  /** The document type. */
  @ApiProperty({ enum: [ERROR_SCHEMA] })
  @Equals(ERROR_SCHEMA)
  schema!: typeof ERROR_SCHEMA;

  @ApiProperty({ enum: [ERROR_SCHEMA_VERSION] })
  @Equals(ERROR_SCHEMA_VERSION)
  schema_version!: typeof ERROR_SCHEMA_VERSION;

  /** The stable machine code. RC6: clients branch on this and tolerate ones they do not know. */
  @ApiProperty({ type: String }) @IsString() error!: string;

  /** The sentence to put in front of a person. Never something to branch on. */
  @ApiProperty({ type: String }) @IsString() message!: string;

  /** Required, because `errorBody` is the only thing that builds one and it always sets this. */
  @ApiProperty({ type: Number }) @IsNumber() status_code!: number;

  /** The longer form, where an arm has one to give. `checkUpload`'s three arms all do. */
  @ApiPropertyOptional({ type: String }) @IsOptional() @IsString() detail?: string;

  /** Preflight's own failure code, on the one arm that has it (`submit.service.ts`'s `!preflight.ok` branch). */
  @ApiPropertyOptional({ type: String }) @IsOptional() @IsString() reason?: string;
}
