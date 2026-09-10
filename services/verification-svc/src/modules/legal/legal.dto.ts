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

// Not `stellar-*`: this is one deployment's operator configuration and is never published to the result root,
// unlike `stellar-verifier-policy-v1`, which is.
export const LEGAL_DOCUMENTS_SCHEMA = "scvs-legal-documents-v1" as const;

export const LEGAL_DOCUMENT_SLUGS = ["terms", "privacy"] as const;

export type LegalDocumentSlug = (typeof LEGAL_DOCUMENT_SLUGS)[number];

/** A paragraph, or a bullet list. The console renders two inline marks: `**bold**` and `[label](href)`. */
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
  /** URL fragment, so a specific clause can be linked to. */
  @ApiProperty({ type: String }) @IsString() id!: string;

  @ApiProperty({ type: String }) @IsString() heading!: string;

  // Declared rather than derived: the union has no class-validator equivalent, and `assertRenderableBlocks`
  // in legal.service.ts is what actually rejects a malformed one at boot.
  @ApiProperty(BLOCKS_SCHEMA)
  @IsArray()
  blocks!: LegalBlock[];
}

export class LegalDocumentDto {
  @ApiProperty({ enum: LEGAL_DOCUMENT_SLUGS })
  @IsIn(LEGAL_DOCUMENT_SLUGS)
  slug!: LegalDocumentSlug;

  @ApiProperty({ type: String }) @IsString() title!: string;

  /** The browser tab title. */
  @ApiProperty({ type: String }) @IsString() document_title!: string;

  @ApiProperty({ type: String }) @IsString() intro!: string;

  @ApiProperty({ type: [LegalSectionDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => LegalSectionDto)
  sections!: LegalSectionDto[];

  /** Questions the operator's draft leaves open. Rendered only while `effective_date` is absent. */
  @ApiProperty({ type: [String] }) @IsArray() @IsString({ each: true }) open_items!: string[];
}

/**
 * The operator-supplied legal bundle: the mechanism ships in this repository and the text does not
 * (versioned-terms-and-assent design.md TA-4).
 */
export class LegalDocumentsBundle {
  @ApiProperty({ enum: [LEGAL_DOCUMENTS_SCHEMA] })
  @Equals(LEGAL_DOCUMENTS_SCHEMA)
  schema!: typeof LEGAL_DOCUMENTS_SCHEMA;

  /** Opaque to this service: compared for equality, never parsed or ordered (design.md §4.2). */
  @ApiProperty({ type: String }) @IsString() version!: string;

  /**
   * Absent or null means the operator's text is not in effect, which keeps acceptance optional (TA-7). The
   * switch is this field, so enforcement begins in the same edit that lands approved text.
   */
  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @IsISO8601({}, { message: "effective_date must be an ISO-8601 date" })
  effective_date?: string | null;

  @ApiProperty({ type: String }) @IsString() operator_name!: string;

  @ApiProperty({ type: String }) @IsString() service_name!: string;

  /** Where a reader can see what was live on an earlier date — the archive design.md §4.4 declines to build. */
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
