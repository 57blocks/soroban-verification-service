import type { Server } from "node:http";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { findWorkspaceRoot } from "@scvs/config";
import { createTestServer } from "./bootstrap.js";
import { LegalService } from "../src/modules/legal/legal.service.js";
import { loadLegalDocumentsSource } from "../src/modules/legal/legal.source.js";

const examplePath = join(findWorkspaceRoot() as string, "config/legal-documents.example.json");

let server: Server;
beforeAll(async () => {
  server = await createTestServer();
});

/** A `LegalService` with no database behind it — every case here is about loading, not about TA-5. */
function serviceFor(source: string): LegalService {
  return new LegalService(
    { get: () => source } as never,
    { findConflictingTermsHash: async () => null } as never,
  );
}

const bootWith = (source: string): Promise<void> => serviceFor(source).onModuleInit();

async function writeBundle(mutate: (bundle: Record<string, unknown>) => void): Promise<string> {
  const bundle = JSON.parse(await readFile(examplePath, "utf8")) as Record<string, unknown>;
  mutate(bundle);
  const dir = await mkdtemp(join(tmpdir(), "scvs-legal-spec-"));
  const path = join(dir, "legal-documents.json");
  await writeFile(path, `${JSON.stringify(bundle, null, 2)}\n`);
  return path;
}

describe("GET /api/verification/v1/legal", () => {
  it("serves the operator's bytes verbatim, with their sha256 as the ETag", async () => {
    // Byte equality, not deep equality of parsed objects: "the hash of the text shown" is only an identity
    // while the response body IS the hashed file (design.md TA-3).
    const raw = await readFile(examplePath, "utf8");
    const expected = createHash("sha256").update(raw, "utf8").digest("hex");

    const response = await request(server).get("/api/verification/v1/legal");

    expect(response.status).toBe(200);
    expect(response.text).toBe(raw);
    expect(response.headers.etag).toBe(`"${expected}"`);
    expect(response.headers["content-type"]).toMatch(/application\/json/);
  });

  it("is cacheable, unlike every job-bearing response", async () => {
    // Public text, so RP-5's `no-store` does not reach it.
    const response = await request(server).get("/api/verification/v1/legal");
    expect(response.headers["cache-control"]).toBe("public, max-age=60");
  });

  it("carries a version and, in the committed example, no effective date", async () => {
    const response = await request(server).get("/api/verification/v1/legal");
    expect(response.body.schema).toBe("scvs-legal-documents-v1");
    expect(typeof response.body.version).toBe("string");
    // The example is placeholder text, so enforcement is off (TA-7) and a fresh checkout still boots.
    expect(response.body.effective_date).toBeNull();
    expect(response.body.documents.map((d: { slug: string }) => d.slug).sort()).toEqual(["privacy", "terms"]);
  });
});

describe("the legal bundle is a boot-time gate", () => {
  it("refuses an unset source rather than serving no terms", async () => {
    await expect(loadLegalDocumentsSource(undefined)).rejects.toThrow(/SCVS_LEGAL_DOCUMENTS_SOURCE is required/);
    await expect(loadLegalDocumentsSource("   ")).rejects.toThrow(/SCVS_LEGAL_DOCUMENTS_SOURCE is required/);
  });

  it("refuses a source it cannot read", async () => {
    await expect(loadLegalDocumentsSource("/nonexistent/legal.json")).rejects.toThrow(
      /Could not read legal documents/,
    );
  });

  it("refuses http:, because acceptance is recorded against these exact bytes", async () => {
    await expect(loadLegalDocumentsSource("http://example.invalid/legal.json")).rejects.toThrow(
      /must be an https: URL or a file path/,
    );
  });

  it("refuses malformed JSON", async () => {
    const dir = await mkdtemp(join(tmpdir(), "scvs-legal-spec-"));
    const path = join(dir, "broken.json");
    await writeFile(path, "{ not json");
    await expect(bootWith(path)).rejects.toThrow(/not valid JSON/);
  });

  it("refuses a bundle whose schema tag is wrong", async () => {
    const path = await writeBundle((bundle) => {
      bundle.schema = "stellar-verifier-policy-v1";
    });
    await expect(bootWith(path)).rejects.toThrow();
  });

  it("refuses a bundle missing a document, and one carrying a slug twice", async () => {
    const missing = await writeBundle((bundle) => {
      bundle.documents = (bundle.documents as unknown[]).slice(0, 1);
    });
    await expect(bootWith(missing)).rejects.toThrow(/missing: privacy/);

    const duplicated = await writeBundle((bundle) => {
      const documents = bundle.documents as unknown[];
      bundle.documents = [documents[0], documents[0]];
    });
    await expect(bootWith(duplicated)).rejects.toThrow(/carry "terms" twice/);
  });

  it("refuses a block the console could not render", async () => {
    const path = await writeBundle((bundle) => {
      const documents = bundle.documents as Array<{ sections: Array<{ blocks: unknown[] }> }>;
      documents[0].sections[0].blocks = [{ list: [42] }];
    });
    await expect(bootWith(path)).rejects.toThrow(/must be a string or \{ list: string\[\] \}/);
  });

  it("loads a bundle that declares an effective date, and reports itself enforced", async () => {
    const path = await writeBundle((bundle) => {
      bundle.effective_date = "2026-09-15";
    });
    const service = serviceFor(path);
    await service.onModuleInit();
    expect(service.isEnforced()).toBe(true);
  });
});
