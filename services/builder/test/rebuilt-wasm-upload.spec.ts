import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Test } from "@nestjs/testing";
import { ConfigModule } from "@nestjs/config";
import { BuilderService } from "../src/modules/builder/builder.service.js";
import configuration from "../src/config/configuration.js";
import { HANDOFF_SCHEMA, handoffPath, writeHandoff } from "../src/modules/builder/handoff.js";
import { uploadRebuiltWasm } from "../src/modules/builder/upload.js";

/**
 * What is asserted here is what is reachable without a Docker socket or a `stellar` binary: the upload
 * primitive's wire shape, and the runner's behaviour on the one path that reaches `finish` with no artifact.
 */

const PUT_URL = "https://example.invalid/staging/rebuild-1/build/rebuilt.wasm?X-Amz-Signature=sig";

type Recorded = { url: string; method?: string; contentType?: string; body?: unknown };

function stubFetch(responder: (url: string) => Response): { calls: Recorded[]; restore: () => void } {
  const original = globalThis.fetch;
  const calls: Recorded[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url, method: init?.method, contentType: headers["content-type"], body: init?.body });
    return responder(url);
  }) as typeof globalThis.fetch;
  return { calls, restore: () => void (globalThis.fetch = original) };
}

describe("uploadRebuiltWasm", () => {
  it("PUTs the raw bytes as application/wasm", async () => {
    const stub = stubFetch(() => new Response("", { status: 200 }));
    try {
      const bytes = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
      const result = await uploadRebuiltWasm(PUT_URL, bytes);

      expect(result).toEqual({ ok: true, status: 200 });
      expect(stub.calls).toHaveLength(1);
      expect(stub.calls[0]).toMatchObject({ url: PUT_URL, method: "PUT", contentType: "application/wasm" });
      // The bytes themselves, not a JSON envelope: the trusted side hashes what arrives here and compares that
      // hash to the deployed Wasm's, so any re-encoding would break every verdict.
      expect(stub.calls[0].body).toBe(bytes);
    } finally {
      stub.restore();
    }
  });

  it("reports a rejected PUT rather than throwing, so the caller can go fatal with the reason", async () => {
    const stub = stubFetch(() => new Response("AccessDenied", { status: 403 }));
    try {
      const result = await uploadRebuiltWasm(PUT_URL, new Uint8Array([1]));
      expect(result).toEqual({ ok: false, status: 403, detail: "AccessDenied" });
    } finally {
      stub.restore();
    }
  });
});

describe("BuilderService, an attempt that produced no artifact", () => {
  let handoffRoot: string;

  beforeEach(async () => {
    handoffRoot = await mkdtemp(join(tmpdir(), "scvs-handoff-test-"));
  });

  afterEach(async () => {
    await rm(handoffRoot, { recursive: true, force: true });
    delete process.env.SCVS_JOB_PARAMS_JSON;
    delete process.env.SCVS_HANDOFF_ROOT;
  });

  it("uploads recipe.json only, and claims no upload it did not make", async () => {
    const jobId = "11111111-2222-3333-4444-555555555555";
    await writeHandoff(handoffPath(handoffRoot, jobId), {
      ok: false,
      schema: HANDOFF_SCHEMA,
      job_id: jobId,
      reason: "source_unreachable",
      status: "failed",
      detail: "The source archive could not be downloaded.",
    });

    process.env.SCVS_HANDOFF_ROOT = handoffRoot;
    process.env.SCVS_JOB_PARAMS_JSON = JSON.stringify({
      job_id: jobId,
      target: { network: "testnet", wasm_hash: "a".repeat(64) },
      source_ref: { type: "public_tarball", visibility: "public", tarball_sha256: "b".repeat(64) },
      image_digest: `docker.io/stellar/stellar-cli@sha256:${"c".repeat(64)}`,
      mode: "build",
      upload_url: "https://example.invalid/staging/rebuild-1/build/recipe.json?X-Amz-Signature=sig",
      artifact_upload_url: PUT_URL,
    });

    const stub = stubFetch(() => new Response("", { status: 200 }));
    try {
      const moduleRef = await Test.createTestingModule({
        imports: [ConfigModule.forRoot({ isGlobal: true, load: [configuration] })],
        providers: [BuilderService],
      }).compile();

      const result = await moduleRef.get(BuilderService).run();

      expect(result.classification).toBe("cli_failure");
      // Exactly one PUT, and not to the artifact target: there were no bytes, so attempting the upload would
      // either 403 or store an empty object the trusted side would then hash.
      expect(stub.calls).toHaveLength(1);
      expect(stub.calls[0].url).not.toBe(PUT_URL);

      const artifact = JSON.parse(String(stub.calls[0].body)) as Record<string, unknown>;
      expect(artifact.classification).toBe("cli_failure");
      expect(artifact.rebuilt_wasm_uploaded).toBeUndefined();
      expect(artifact.reason).toBe("source_unreachable");
    } finally {
      stub.restore();
    }
  });
});
