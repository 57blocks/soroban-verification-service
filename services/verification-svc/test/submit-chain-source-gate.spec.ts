import { createHash, randomBytes } from "node:crypto";
import { jest } from "@jest/globals";
import { findWorkspaceRoot } from "@scvs/config";
import { join } from "node:path";
import { compareSourceAgainstChain, compareTargetAgainstChain } from "../src/modules/preflight/manifest.js";
import { LegalService } from "../src/modules/legal/legal.service.js";
import { SubmitService } from "../src/modules/verifications/submit.service.js";

const hash = () => createHash("sha256").update(randomBytes(64)).digest("hex");

describe("compareSourceAgainstChain", () => {
  it("refuses a submission whose archive hashes to something the chain does not record", () => {
    const chain = hash();
    const submitted = hash();

    const result = compareSourceAgainstChain(chain, submitted);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toBe("source_archive_not_chain_recorded");
    expect(result.detail).toContain(chain);
    expect(result.detail).toContain(submitted);
  });

  it("admits a submission whose archive is the one the chain records", () => {
    const same = hash();
    expect(compareSourceAgainstChain(same, same)).toEqual({ ok: true });
  });

  it("treats hex case as insignificant", () => {
    const lower = hash();
    expect(compareSourceAgainstChain(lower.toUpperCase(), lower)).toEqual({ ok: true });
    expect(compareSourceAgainstChain(lower, lower.toUpperCase())).toEqual({ ok: true });
  });

  it("admits a contract that records no source_sha256 at all", () => {
    expect(compareSourceAgainstChain(undefined, hash())).toEqual({ ok: true });
  });

  it("admits the submission when the chain could not be read", () => {
    expect(compareSourceAgainstChain("", hash())).toEqual({ ok: true });
  });
});

describe("compareTargetAgainstChain", () => {
  const contract = `C${"A".repeat(55)}`;

  it("refuses a wasm_hash beside a contract_id when the contract runs another Wasm", () => {
    const deployed = hash();
    const named = hash();

    const result = compareTargetAgainstChain({ contract_id: contract, wasm_hash: named }, deployed);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toBe("target_wasm_not_deployed");
    expect(result.detail).toContain(deployed);
    expect(result.detail).toContain(named);
  });

  it("admits the Wasm the contract runs, whatever its hex case", () => {
    const deployed = hash();
    expect(compareTargetAgainstChain({ contract_id: contract, wasm_hash: deployed.toUpperCase() }, deployed)).toEqual({ ok: true });
  });

  it("admits a target that names only one of the two, or a chain that could not be read", () => {
    expect(compareTargetAgainstChain({ contract_id: contract }, hash())).toEqual({ ok: true });
    expect(compareTargetAgainstChain({ wasm_hash: hash() }, hash())).toEqual({ ok: true });
    expect(compareTargetAgainstChain({ contract_id: contract, wasm_hash: hash() }, undefined)).toEqual({ ok: true });
  });
});

describe("a submission the chain refuses leaves its upload's visibility open", () => {
  const SECRET = "s3cret";
  const secretSha256 = createHash("sha256").update(SECRET).digest("hex");

  async function serviceReading(chain: { wasm_hash: string; source_sha256?: string }) {
    const legal = new LegalService(
      { get: () => join(findWorkspaceRoot() as string, "config/legal-documents.example.json") } as never,
      {} as never,
    );
    await legal.onModuleInit();
    const uploads = {
      getUpload: jest.fn(async () => ({
        received: true,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        secretSha256,
        visibilityLocked: false,
        visibility: undefined,
        sourceSha256: SOURCE,
      })),
      lockUploadVisibility: jest.fn(async () => true),
    };
    const jobs = { getActiveJobForTarget: jest.fn(), createJob: jest.fn() };
    class ChainStub extends SubmitService {
      protected override readChain() {
        return Promise.resolve({ ok: true, metadata: { wasm_hash: chain.wasm_hash, sep58: { source_sha256: chain.source_sha256 } } } as never);
      }
    }
    const service = new ChainStub(
      { get: (key: string) => (key === "activeJobDedupStaleMs" ? 30 * 60_000 : undefined) } as never,
      jobs as never,
      uploads as never,
      { recordReference: jest.fn() } as never,
      legal as never,
    );
    return { service, uploads, jobs };
  }

  const SOURCE = hash();
  const submission = (target: Record<string, string>) => ({
    target: { network: "testnet" as const, ...target },
    upload_secret: SECRET,
    manifest: { schema: "stellar-submitted-source-verification-manifest-v1", source_sha256: SOURCE, upload_id: "3f2b6c1e-8a4d-4f7b-9c2e-1d5a6b7c8d9e", is_public: true },
  });

  it("refuses a contract named with a Wasm it does not run, before locking the upload", async () => {
    const { service, uploads, jobs } = await serviceReading({ wasm_hash: hash() });

    const response = await service.submit(submission({ contract_id: `C${"B".repeat(55)}`, wasm_hash: hash() }) as never);

    expect(response.statusCode).toBe(400);
    expect(response.body).toMatchObject({ error: "target_wasm_not_deployed" });
    expect(uploads.lockUploadVisibility).not.toHaveBeenCalled();
    expect(jobs.createJob).not.toHaveBeenCalled();
  });

  it("refuses an archive the chain does not record, before locking the upload", async () => {
    const { service, uploads } = await serviceReading({ wasm_hash: hash(), source_sha256: hash() });

    const response = await service.submit(submission({ wasm_hash: hash() }) as never);

    expect(response.statusCode).toBe(400);
    expect(response.body).toMatchObject({ error: "source_archive_not_chain_recorded" });
    expect(uploads.lockUploadVisibility).not.toHaveBeenCalled();
  });
});
