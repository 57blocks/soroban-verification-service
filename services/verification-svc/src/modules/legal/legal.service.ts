import { createHash } from "node:crypto";
import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JobsRepository } from "@scvs/db";
import { parseDto, ScvsLogger } from "@scvs/core";
import {
  LEGAL_DOCUMENT_SLUGS,
  LegalDocumentsBundle,
  type LegalBlock,
  type LegalDocumentSlug,
} from "./legal.dto.js";
import { loadLegalDocumentsSource } from "./legal.source.js";
import type { AppConfigService } from "../../config/configuration.js";

/** What a submission's `accepted_terms_version` resolved to. */
export type AcceptanceCheck =
  | { accepted: true; version?: string; contentSha256?: string }
  | { accepted: false; error: "terms_acceptance_required" | "terms_version_outdated"; message: string };

type LoadedBundle = {
  bundle: LegalDocumentsBundle;
  /** The bytes as loaded. Served verbatim and hashed, so "the hash of the text shown" needs no canonical form. */
  raw: string;
  contentSha256: string;
};

@Injectable()
export class LegalService implements OnModuleInit {
  private readonly logger = new ScvsLogger("legal");
  private loaded?: LoadedBundle;

  constructor(
    @Inject(ConfigService) private readonly configService: AppConfigService,
    @Inject(JobsRepository) private readonly jobs: JobsRepository,
  ) {}

  /** Every failure here is fatal: a console that takes submissions while showing nobody any terms is the defect. */
  async onModuleInit(): Promise<void> {
    const configured = this.configService.get("legalDocumentsSource", { infer: true });
    const { label, raw } = await loadLegalDocumentsSource(configured);

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw);
    } catch (error) {
      throw new Error(`Legal documents at ${label} are not valid JSON: ${(error as Error).message}`);
    }

    const bundle = parseDto(LegalDocumentsBundle, parsedJson);
    assertOneOfEachSlug(bundle, label);
    assertRenderableBlocks(bundle, label);

    const contentSha256 = createHash("sha256").update(raw, "utf8").digest("hex");
    this.loaded = { bundle, raw, contentSha256 };

    this.logger.log("legal documents loaded", {
      source: label,
      terms_version: bundle.version,
      content_sha256: contentSha256,
      effective_date: bundle.effective_date ?? null,
      enforced: this.isEnforced(),
    });
  }

  /**
   * TA-5, and it needs the database, so it is called from `main.ts`'s bootstrap rather than `onModuleInit` —
   * the same seam that lets `generate-openapi.ts` boot this app with no database at all.
   */
  async assertNoVersionConflict(): Promise<void> {
    const { bundle, contentSha256 } = this.require();
    const conflicting = await this.jobs.findConflictingTermsHash(bundle.version, contentSha256);
    if (!conflicting) return;
    throw new Error(
      `Legal documents version "${bundle.version}" is already bound to different text: a job records ` +
        `${conflicting}, this deployment would serve ${contentSha256}. Editing the text without moving ` +
        `\`version\` would leave those jobs asserting words that changed. Give the edit a new version.`,
    );
  }

  bundle(): LegalDocumentsBundle {
    return this.require().bundle;
  }

  raw(): string {
    return this.require().raw;
  }

  contentSha256(): string {
    return this.require().contentSha256;
  }

  version(): string {
    return this.require().bundle.version;
  }

  /** True once the operator's document declares an effective date (TA-7). */
  isEnforced(): boolean {
    return Boolean(this.require().bundle.effective_date);
  }

  /**
   * TA-2 and TA-7 together. A version we do not serve is refused whether or not enforcement is on: accepting
   * it would bind a job to words nobody was shown.
   */
  checkAcceptance(supplied: string | undefined): AcceptanceCheck {
    const { bundle, contentSha256 } = this.require();
    const version = supplied?.trim();

    if (!version) {
      if (!this.isEnforced()) return { accepted: true };
      return {
        accepted: false,
        error: "terms_acceptance_required",
        message:
          `This submission must carry \`accepted_terms_version\`. The current version is ` +
          `"${bundle.version}"; fetch GET /api/verification/v1/legal and submit the version you accepted.`,
      };
    }

    if (version !== bundle.version) {
      return {
        accepted: false,
        error: "terms_version_outdated",
        message:
          `\`accepted_terms_version\` "${version}" is not the version this service serves ` +
          `("${bundle.version}"). Re-read GET /api/verification/v1/legal and accept the current terms.`,
      };
    }

    return { accepted: true, version: bundle.version, contentSha256 };
  }

  private require(): LoadedBundle {
    if (!this.loaded) throw new Error("LegalService was read before onModuleInit loaded the bundle");
    return this.loaded;
  }
}

function assertOneOfEachSlug(bundle: LegalDocumentsBundle, label: string): void {
  const seen = new Set<LegalDocumentSlug>();
  for (const document of bundle.documents) {
    if (seen.has(document.slug)) {
      throw new Error(`Legal documents at ${label} carry "${document.slug}" twice; each slug must appear once`);
    }
    seen.add(document.slug);
  }
  const missing = LEGAL_DOCUMENT_SLUGS.filter((slug) => !seen.has(slug));
  if (missing.length > 0) {
    throw new Error(`Legal documents at ${label} are missing: ${missing.join(", ")}`);
  }
}

/** The block union has no class-validator equivalent, so the shape the console renders is asserted here. */
function assertRenderableBlocks(bundle: LegalDocumentsBundle, label: string): void {
  for (const document of bundle.documents) {
    for (const section of document.sections) {
      for (const [index, block] of section.blocks.entries()) {
        if (!isRenderableBlock(block)) {
          throw new Error(
            `Legal documents at ${label}: ${document.slug}.${section.id} block ${index} must be a string ` +
              `or { list: string[] }`,
          );
        }
      }
    }
  }
}

function isRenderableBlock(block: LegalBlock): boolean {
  if (typeof block === "string") return true;
  return (
    typeof block === "object" &&
    block !== null &&
    Array.isArray((block as { list?: unknown }).list) &&
    (block as { list: unknown[] }).list.every((entry) => typeof entry === "string")
  );
}
