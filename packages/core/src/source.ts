import { Type } from "class-transformer";
import { Equals, IsArray, IsBoolean, IsIn, IsOptional, IsString, ValidateNested } from "class-validator";
import { DtoValidationError, parseDto, type ClassConstructor } from "./validate.js";
import { VerificationTarget } from "./target.js";
import { LowercaseHex } from "./validators/lowercase-hex.js";

export class GitSourceRef {
  @Equals("git") type!: "git";
  @Equals("public") visibility!: "public";
  @IsString() repo!: string;
  @IsString() rev!: string;
  @IsOptional() @IsString() source_uri?: string;
  @IsOptional() @LowercaseHex() @IsString() source_sha256?: string;
}

export class HostedTarballSourceRef {
  @Equals("hosted_tarball") type!: "hosted_tarball";
  @Equals("public") visibility!: "public";
  @IsString() tarball_url!: string;
  @LowercaseHex() @IsString() tarball_sha256!: string;
  @IsOptional() @IsString() source_uri?: string;
  @IsOptional() @LowercaseHex() @IsString() source_sha256?: string;
}

export class PrivateTarballSourceRef {
  @Equals("private_tarball") type!: "private_tarball";
  @IsIn(["public", "private"]) visibility!: "public" | "private";
  @LowercaseHex() @IsString() tarball_sha256!: string;
  @IsOptional() @IsString() upload_id?: string;
  @IsOptional() @IsString() source_uri?: string;
  @IsOptional() @LowercaseHex() @IsString() source_sha256?: string;
}

export class SourceUriSourceRef {
  @Equals("source_uri") type!: "source_uri";
  @IsIn(["public", "private"]) visibility!: "public" | "private";
  @IsOptional() @IsString() source_uri?: string;
  @LowercaseHex() @IsString() source_sha256!: string;
  @IsOptional() @IsString() upload_id?: string;
}

export type SourceReference = GitSourceRef | HostedTarballSourceRef | PrivateTarballSourceRef | SourceUriSourceRef;

const sourceReferenceSubTypes: Array<{ value: ClassConstructor<SourceReference>; name: SourceReference["type"] }> = [
  { value: GitSourceRef, name: "git" },
  { value: HostedTarballSourceRef, name: "hosted_tarball" },
  { value: PrivateTarballSourceRef, name: "private_tarball" },
  { value: SourceUriSourceRef, name: "source_uri" },
];

export const sourceReferenceDiscriminator = {
  property: "type" as const,
  subTypes: sourceReferenceSubTypes,
};

export function parseSourceReference(value: unknown): SourceReference {
  const type = value && typeof value === "object" ? (value as { type?: unknown }).type : undefined;
  const match = sourceReferenceSubTypes.find((s) => s.name === type);
  if (!match) {
    throw new DtoValidationError([
      {
        target: undefined,
        property: "type",
        value: type,
        constraints: { isIn: `type must be one of: ${sourceReferenceSubTypes.map((s) => s.name).join(", ")}` },
      } as never,
    ]);
  }
  return parseDto(match.value, value);
}

export class BuildRecipe {
  @IsString() image!: string;
  @IsString() workspace_path!: string;
  @IsOptional() @IsString() package?: string;
  @IsOptional() @IsIn(["release", "debug"]) profile?: "release" | "debug";
  @IsOptional() @IsArray() @IsString({ each: true }) features?: string[];
  @Equals("wasm32v1-none") target!: "wasm32v1-none";
  @IsOptional() @IsArray() @IsString({ each: true }) bldarg?: string[];
  @IsOptional() @IsArray() @IsString({ each: true }) bldopt?: string[];
  @IsOptional() @IsArray() @IsString({ each: true }) metadata_replay?: string[];
}

export class SubmittedSourceManifest {
  @Equals("stellar-submitted-source-verification-manifest-v1")
  schema!: "stellar-submitted-source-verification-manifest-v1";
  @ValidateNested() @Type(() => VerificationTarget) target!: VerificationTarget;
  @IsOptional() @IsString() bldimg?: string;
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  bldarg?: string[];
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  bldopt?: string[];
  @LowercaseHex() @IsString() source_sha256!: string;
  @IsOptional() @IsString() source_uri?: string;
  @IsOptional() @IsString() upload_id?: string;
  @IsOptional() @IsBoolean() is_public?: boolean;
}

export const ACCEPTED_UPLOAD_ARCHIVE_SUFFIXES = [".tar.gz", ".tgz", ".gz", ".zip"] as const;
