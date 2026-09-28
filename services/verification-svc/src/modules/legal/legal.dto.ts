import { ApiProperty, ApiPropertyOptional, type ApiPropertyOptions } from "@nestjs/swagger";
import { Type } from "class-transformer";
import {
  ArrayNotEmpty,
  Equals,
  IsArray,
  IsIn,
  IsISO8601,
  IsOptional,
  IsString,
  ValidateNested,
} from "class-validator";

export const LEGAL_DOCUMENTS_SCHEMA = "scvs-legal-documents-v1" as const;

export const LEGAL_DOCUMENT_SLUGS = ["terms", "privacy"] as const;

export type LegalDocumentSlug = (typeof LEGAL_DOCUMENT_SLUGS)[number];

export type LegalBlock = string | { list: string[] };

const BLOCKS_SCHEMA: ApiPropertyOptions = {
  type: "array",
  items: {
    oneOf: [
      { type: "string" },
      {
        type: "object",
        properties: { list: { type: "array", items: { type: "string" } } },
        required: ["list"],
      },
    ],
  },
};

export class LegalSectionDto {
  @ApiProperty({ type: String }) @IsString() id!: string;

  @ApiProperty({ type: String }) @IsString() heading!: string;

  @ApiProperty(BLOCKS_SCHEMA)
  @IsArray()
  blocks!: LegalBlock[];
}

export class LegalDocumentDto {
  @ApiProperty({ enum: LEGAL_DOCUMENT_SLUGS })
  @IsIn(LEGAL_DOCUMENT_SLUGS)
  slug!: LegalDocumentSlug;

  @ApiProperty({ type: String }) @IsString() title!: string;

  @ApiProperty({ type: String }) @IsString() document_title!: string;

  @ApiProperty({ type: String }) @IsString() intro!: string;

  @ApiProperty({ type: [LegalSectionDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => LegalSectionDto)
  sections!: LegalSectionDto[];

  @ApiProperty({ type: [String] }) @IsArray() @IsString({ each: true }) open_items!: string[];
}

export class LegalDocumentsBundle {
  @ApiProperty({ enum: [LEGAL_DOCUMENTS_SCHEMA] })
  @Equals(LEGAL_DOCUMENTS_SCHEMA)
  schema!: typeof LEGAL_DOCUMENTS_SCHEMA;

  @ApiProperty({ type: String }) @IsString() version!: string;

  /** Absent or null: the text is not in effect and acceptance is optional. */
  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @IsISO8601({}, { message: "effective_date must be an ISO-8601 date" })
  effective_date?: string | null;

  @ApiProperty({ type: String }) @IsString() operator_name!: string;

  @ApiProperty({ type: String }) @IsString() service_name!: string;

  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @IsString()
  history_url?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @IsString()
  contact_url?: string | null;

  @ApiProperty({ type: [LegalDocumentDto] })
  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => LegalDocumentDto)
  documents!: LegalDocumentDto[];
}
