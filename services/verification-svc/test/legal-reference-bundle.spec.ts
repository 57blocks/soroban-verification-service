import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { findWorkspaceRoot } from "@scvs/config";
import { parseDto } from "@scvs/core";
import { LegalDocumentsBundle, type LegalBlock, type LegalDocumentSlug } from "../src/modules/legal/legal.dto.js";
import { loadLegalDocumentsSource } from "../src/modules/legal/legal.source.js";

const root = findWorkspaceRoot() as string;
const REFERENCE = "config/legal-documents.json";

let bundle: LegalDocumentsBundle;
let raw: string;

beforeAll(async () => {
  raw = await readFile(join(root, REFERENCE), "utf8");
  bundle = parseDto(LegalDocumentsBundle, JSON.parse(raw));
});

const text = (slug: LegalDocumentSlug): string => {
  const document = bundle.documents.find((candidate) => candidate.slug === slug);
  if (!document) throw new Error(`${REFERENCE} carries no ${slug} document`);
  return document.sections
    .flatMap(({ blocks }) => blocks.map(flatten))
    .join(" ");
};

const flatten = (block: LegalBlock): string => (typeof block === "string" ? block : block.list.join(" "));

describe("the configured bundle is one this service can actually serve", () => {
  it("validates, and loads through the real loader by its relative path", async () => {
    const loaded = await loadLegalDocumentsSource(REFERENCE);
    expect(loaded.raw).toBe(raw);
    expect(bundle.schema).toBe("scvs-legal-documents-v1");
  });

  it("carries both documents, once each, with unique section ids", () => {
    expect(bundle.documents.map((document) => document.slug).sort()).toEqual(["privacy", "terms"]);
    for (const document of bundle.documents) {
      const ids = document.sections.map((section) => section.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it("is still a draft, so acceptance stays offered and not required", () => {
    expect(bundle.effective_date ?? null).toBeNull();
    expect(bundle.documents.every((document) => document.open_items.length > 0)).toBe(true);
  });

  it("resolves every interpolation the TypeScript modules used to carry", () => {
    expect(raw).not.toContain("${");
    expect(bundle.operator_name).toBe("57Blocks");
  });

  it("points its revision history at where the documents now live — in the body text too", () => {
    expect(bundle.history_url).toContain(REFERENCE);
    expect(raw).not.toContain("clients/web/src/features/legal/content");
  });
});

describe("the terms say what the Service actually does", () => {
  it("separate the report, which cannot be recalled, from source, which can", () => {
    const terms = text("terms");
    expect(terms).toMatch(/it cannot afterwards be altered or withdrawn by anyone, including us/);
    expect(terms).toMatch(/a request to remove published source can be acted on/i);
    expect(terms).toMatch(/We do not monitor or pre-screen submitted material/);
    expect(terms).not.toMatch(/prevention is the only remedy/);
  });

  it("name the contracting entity and the law that governs them", () => {
    const terms = text("terms");
    const intro = bundle.documents.find((document) => document.slug === "terms")!.intro;
    expect(intro).toMatch(/57Blocks Technology Inc\., a California corporation/);
    expect(terms).toMatch(/governed by the laws of the State of California/);
    expect(terms).toMatch(/3001 Bishop Dr, Suite 300, San Ramon/);
    expect(terms).toMatch(/exclusive jurisdiction and venue of the state and federal courts located in Contra Costa County/);
  });

  it("cap liability at a non-zero amount, and carve out what cannot lawfully be limited", () => {
    const terms = text("terms");
    expect(terms).toMatch(/AGGREGATE LIABILITY .* WILL NOT EXCEED US\$500/);
    expect(terms).toMatch(/DO NOT APPLY TO LIABILITY THAT CANNOT LAWFULLY BE LIMITED OR EXCLUDED/);
    expect(terms).not.toMatch(/THE AMOUNT YOU PAID FOR THE SERVICE, WHICH IS NOTHING/);
  });

  it("give both documents a private channel for notices, not only the public tracker", () => {
    for (const slug of ["terms", "privacy"] as const) {
      expect(text(slug)).toMatch(/sv\.legal@57blocks\.com/);
    }
    expect(text("terms")).not.toMatch(/designated agent|registered with the U\.S\. Copyright Office/i);
  });

  it("describe the logs that exist, with the period they are actually kept for", () => {
    const privacy = text("privacy");
    expect(privacy).toMatch(/is \*\*not\*\* configured to write access logs/);
    expect(privacy).toMatch(/deleted after 30 days/);
    expect(privacy).not.toMatch(/a limited period under the hosting provider's configuration/);
  });

  it("state a basis for each purpose without asserting that EU law reaches the Service", () => {
    const privacy = text("privacy");
    expect(privacy).toMatch(/If EU or UK data protection law applies to you/);
    expect(privacy).toMatch(/performance of the agreement/);
    expect(privacy).toMatch(/legitimate interests/);
    expect(privacy).toMatch(/We do not rely on consent/);
  });

  it("say a verdict is not an audit", () => {
    expect(text("terms")).toMatch(/not a security audit/);
  });

  it("warn against submitting secrets without using that as an excuse", () => {
    const terms = text("terms");
    expect(terms).toMatch(/Do not submit secrets/);
    expect(terms).toMatch(/not a confidential-computing service and not secure storage/);
    expect(terms).toMatch(/controls described here are ones we hold ourselves to regardless/);
    expect(terms).toMatch(/There is no way to re-issue the token/);
  });
});

describe("the privacy notice says what the Service actually does", () => {
  it("describes the rate-limit fingerprint as keyed and rotating", () => {
    const privacy = text("privacy");
    expect(privacy).toMatch(/HMAC-SHA-256 fingerprint of the requesting IP address/);
    expect(privacy).toMatch(/cannot be linked across windows or reversed/);
    expect(privacy).not.toMatch(/pseudonymous, not anonymous/);
  });

  it("describes the raw log and the summary as separate tiers", () => {
    const privacy = text("privacy");
    expect(privacy).toMatch(/\*\*Raw build logs\.\*\*/);
    expect(privacy).toMatch(/\*\*Diagnostic summary\.\*\*/);
    expect(privacy).toMatch(/deleted 7 days after the build finishes/);
    expect(privacy).toMatch(/the job link does not open it/);
    expect(privacy).toMatch(/contains no compiler output/i);
    expect(privacy).not.toMatch(/served to anyone who holds the job link/);
  });

  it("states both retention periods, not just the permanent one", () => {
    const privacy = text("privacy");
    expect(privacy).toMatch(/counters are deleted fifteen minutes after their window closes/);
    expect(privacy).toMatch(/deleted 30 days after it was created/);
    expect(privacy).not.toMatch(/Job records are retained indefinitely/);
  });

  it("mentions no third party the console no longer contacts", () => {
    for (const slug of ["terms", "privacy"] as const) {
      expect(text(slug)).not.toMatch(/Google/i);
    }
  });
});
