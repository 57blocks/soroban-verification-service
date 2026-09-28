import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Equals, IsNumber, IsOptional, IsString } from "class-validator";
import { ERROR_SCHEMA, ERROR_SCHEMA_VERSION } from "./api-error.js";

export class ApiErrorResponse {
  @ApiProperty({ enum: [ERROR_SCHEMA] })
  @Equals(ERROR_SCHEMA)
  schema!: typeof ERROR_SCHEMA;

  @ApiProperty({ enum: [ERROR_SCHEMA_VERSION] })
  @Equals(ERROR_SCHEMA_VERSION)
  schema_version!: typeof ERROR_SCHEMA_VERSION;

  /** The stable machine code; clients branch on this and tolerate unknown ones. */
  @ApiProperty({ type: String }) @IsString() error!: string;

  /** The sentence to put in front of a person. Never something to branch on. */
  @ApiProperty({ type: String }) @IsString() message!: string;

  @ApiProperty({ type: Number }) @IsNumber() status_code!: number;

  @ApiPropertyOptional({ type: String }) @IsOptional() @IsString() detail?: string;

  @ApiPropertyOptional({ type: String }) @IsOptional() @IsString() reason?: string;
}
