import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { findWorkspaceRoot } from "@scvs/config";
import { parseDto } from "@scvs/core";
import { LegalDocumentsBundle, type LegalBlock, type LegalDocumentSlug } from "../src/modules/legal/legal.dto.js";
import { loadLegalDocumentsSource } from "../src/modules/legal/legal.source.js";

/**
 * The reference deployment's own bundle, the one `dev` and `staging` are configured with.
 *
 * **This file is where the text-versus-behaviour coverage lives now.** It used to be a `describe` block in
 * `clients/web/test/legal-pages.spec.tsx` asserting the wording of the two documents while they were
 * TypeScript modules in the console bundle. Moving the text to operator configuration moved its guard here,
 * rather than losing it — every assertion below is one the console spec used to make, and each one exists
 * because the sentence it checks is a claim about what the code actually does.
 */
const root = findWorkspaceRoot() as string;
const REFERENCE = "config/legal-documents.json";

let bundle: LegalDocumentsBundle;
let raw: string;

beforeAll(async () => {
  raw = await readFile(join(root, REFERENCE), "utf8");
  bundle = parseDto(LegalDocumentsBundle, JSON.parse(raw));
});

/** Every paragraph and list entry of one document, flattened — the same shape the old spec asserted over. */
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
    // The relative path is what `config/deploy/{dev,staging}/verification-svc.json` carries, and it resolves
    // against the workspace root rather than the cwd — which in the image is `/app`.
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
    // If this fails because an effective date was set, that is the intended path — enforcement begins, and
    // this expectation becomes `not.toBeNull()` in the same change.
    expect(bundle.effective_date ?? null).toBeNull();
    expect(bundle.documents.every((document) => document.open_items.length > 0)).toBe(true);
  });

  it("resolves every interpolation the TypeScript modules used to carry", () => {
    // The text came from template literals over `serviceName` / `operatorName` / URL constants. A `${` left
    // in the JSON would be a transcription that never got evaluated.
    expect(raw).not.toContain("${");
    expect(bundle.operator_name).toBe("57Blocks");
  });

  it("points its revision history at where the documents now live — in the body text too", () => {
    // Not at `clients/web/.../legal/content`, which no longer exists: a reader following this link has to
    // reach the file the next revision will actually change.
    expect(bundle.history_url).toContain(REFERENCE);
    // And the same URL is interpolated *inside* two paragraphs (terms §7, privacy §8). Asserting only the
    // top-level field missed them, and a dead link in the published legal text is worse than one in metadata.
    expect(raw).not.toContain("clients/web/src/features/legal/content");
  });
});

describe("the terms say what the Service actually does", () => {
  // Withdrawing source from Arweave split one claim into two, and the terms are only correct if they carry
  // both halves: the report stays beyond recall, and our copy of public source no longer is. A test that
  // asserted the old single claim would now be enforcing a false statement, so it asserts the pair instead.
  it("separate the report, which cannot be recalled, from source, which can", () => {
    const terms = text("terms");
    expect(terms).toMatch(/it cannot afterwards be altered or withdrawn by anyone, including us/);
    expect(terms).toMatch(/a request to remove published source can be acted on/i);
    expect(terms).toMatch(/We do not monitor or pre-screen submitted material/);
    // The sentence that made prevention the only remedy went with the architecture that forced it.
    expect(terms).not.toMatch(/prevention is the only remedy/);
  });

  it("name the contracting entity and the law that governs them", () => {
    const terms = text("terms");
    // `text()` joins the sections only, and the contracting entity belongs in the intro — where a reader
    // meets it before anything it governs — so that half is asserted against the intro itself.
    const intro = bundle.documents.find((document) => document.slug === "terms")!.intro;
    expect(intro).toMatch(/57Blocks Technology Inc\., a California corporation/);
    expect(terms).toMatch(/governed by the laws of the State of California/);
    // A public issue tracker is not a channel for a rights claim; a postal address is.
    expect(terms).toMatch(/3001 Bishop Dr, Suite 300, San Ramon/);
    expect(terms).toMatch(/exclusive jurisdiction and venue of the state and federal courts located in Contra Costa County/);
  });

  // A cap of zero is the one a court is likeliest to strike, and striking it leaves no cap at all — so the
  // number being non-zero is the point, and the carve-outs are what keep it from overreaching in the other
  // direction. California forbids excluding fraud, willful injury, and violation of law outright.
  it("cap liability at a non-zero amount, and carve out what cannot lawfully be limited", () => {
    const terms = text("terms");
    expect(terms).toMatch(/AGGREGATE LIABILITY .* WILL NOT EXCEED US\$500/);
    expect(terms).toMatch(/DO NOT APPLY TO LIABILITY THAT CANNOT LAWFULLY BE LIMITED OR EXCLUDED/);
    expect(terms).not.toMatch(/THE AMOUNT YOU PAID FOR THE SERVICE, WHICH IS NOTHING/);
  });

  // Counsel's objection was that a public issue tracker is not a channel for a rights claim or a privacy
  // request. Both documents must name a real one, and the notice may not be published as registered until
  // it is — so this asserts the channel exists, not that an agent is designated.
  it("give both documents a private channel for notices, not only the public tracker", () => {
    for (const slug of ["terms", "privacy"] as const) {
      expect(text(slug)).toMatch(/sv\.support@57blocks\.com/);
    }
    expect(text("terms")).not.toMatch(/designated agent|registered with the U\.S\. Copyright Office/i);
  });

  it("say a verdict is not an audit", () => {
    expect(text("terms")).toMatch(/not a security audit/);
  });

  it("warn against submitting secrets without using that as an excuse", () => {
    const terms = text("terms");
    expect(terms).toMatch(/Do not submit secrets/);
    expect(terms).toMatch(/not a confidential-computing service and not secure storage/);
    // Counsel asks for the disclaimer AND for it not to read as a licence to be careless.
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
    // The bearer-link model, described accurately when it was true, must not survive its removal.
    expect(privacy).not.toMatch(/served to anyone who holds the job link/);
  });

  it("states both retention periods, not just the permanent one", () => {
    const privacy = text("privacy");
    expect(privacy).toMatch(/counters are deleted fifteen minutes after their window closes/);
    expect(privacy).toMatch(/deleted 30 days after it was created/);
    expect(privacy).not.toMatch(/Job records are retained indefinitely/);
  });

  it("mentions no third party the console no longer contacts", () => {
    // Self-hosting the typefaces removed the vendor, so every statement about it had to go with it — a
    // notice describing a request the console no longer makes is as wrong as one omitting a request it does.
    for (const slug of ["terms", "privacy"] as const) {
      expect(text(slug)).not.toMatch(/Google/i);
    }
  });
});
