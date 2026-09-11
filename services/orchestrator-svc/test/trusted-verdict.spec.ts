import { createHash } from "node:crypto";
import { jest } from "@jest/globals";
import type { ConfigService } from "@nestjs/config";
import type { BuildArtifact } from "@scvs/core";
import type {
  JobsRepository,
  MarkRebuildTerminalInput,
  RebuildRecord,
  RebuildsRepository,
} from "@scvs/db";
import { resolveJobVerdict } from "../src/modules/verification-pipeline/verdict.util.js";
import type { AppConfigService } from "../src/config/configuration.js";

/**
 * Written as the attack rather than as a unit test of a getter: the artifact claims the deployed hash, the
 * bytes are something else, and the question is which one reaches `resolveJobVerdict`.
 */

const getObjectTextBounded = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const getObjectBytesBounded = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const putObjectText = jest.fn<(...args: unknown[]) => Promise<void>>();

jest.unstable_mockModule("@scvs/aws", () => ({
  createS3Client: () => ({}),
  getObjectTextBounded,
  getObjectBytesBounded,
  putObjectText,
  // Imported transitively; an ESM named import the factory does not provide is a link-time error.
  createBatchClient: () => ({}),
  describeJob: async () => undefined,
  presignPutUrl: async () => "https://example.invalid/put",
  submitJob: async () => "batch-job-1",
}));

const { RebuildOutcomeService } = await import(
  "../src/modules/batch-events/rebuild-outcome.service.js"
);

/** `recipe.json` as the bounded reader now returns it. */
const givenArtifact = (json: string) => getObjectTextBounded.mockResolvedValue({ text: json });

/** What the contract actually deploys, and what a false `verified` would have to claim. */
const DEPLOYED_HASH = "d".repeat(64);
const MAX_BYTES = 16 * 1024 * 1024;

/** Bytes that are emphatically *not* the deployed contract — a minimal Wasm header plus a marker. */
const HONEST_BYTES = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0xde, 0xad]);
const HONEST_HASH = createHash("sha256").update(HONEST_BYTES).digest("hex");

const REBUILD: RebuildRecord = {
  rebuildId: "11111111-2222-3333-4444-555555555555",
  idempotencyKey: "k".repeat(64),
  sourceRef: { type: "public_tarball", visibility: "public", tarball_sha256: "b".repeat(64) },
  buildOptions: [],
  imageDigest: `docker.io/stellar/stellar-cli@sha256:${"c".repeat(64)}`,
  status: "running",
  buildMode: "build",
  createdAt: "2026-08-10T00:00:00.000Z",
  updatedAt: "2026-08-10T00:00:00.000Z",
};

function artifact(over: Partial<BuildArtifact> = {}): string {
  return JSON.stringify({
    recipe: {
      image: REBUILD.imageDigest,
      workspace_path: ".",
      target: "wasm32v1-none",
      bldarg: ["contract", "build"],
      bldopt: [],
    },
    runner: "docker_build_image_rebuild",
    built_at: "2026-08-10T00:00:00.000Z",
    exit_code: 0,
    classification: "success",
    rebuilt_wasm_uploaded: true,
    ...over,
  });
}

/** Captures what `markTerminal` was asked to persist — the value every attached job then verdicts on. */
function harness() {
  const recorded: MarkRebuildTerminalInput[] = [];
  const rebuilds = {
    markTerminal: async (_id: string, input: MarkRebuildTerminalInput) => void recorded.push(input),
  } as unknown as RebuildsRepository;

  const configService = {
    get: (key: string) =>
      key === "stagingStorage"
        ? { bucket: "scvs-staging", region: "ap-southeast-2" }
        : key === "maxRebuiltWasmBytes"
          ? MAX_BYTES
          : undefined,
  } as unknown as AppConfigService & ConfigService;

  // Recorded rather than faked away — `build-log-key.spec.ts` covers the query itself against the real
  // database; what this file needs is the *ordering* (see its own describe).
  const buildLogKeys: { rebuildId: string; key: string }[] = [];
  const jobs = {
    recordBuildLogKeyForRebuild: async (rebuildId: string, key: string) => {
      buildLogKeys.push({ rebuildId, key });
      return 1;
    },
  } as unknown as JobsRepository;

  return {
    recorded,
    buildLogKeys,
    service: new RebuildOutcomeService(configService, rebuilds, jobs),
  };
}

beforeEach(() => {
  getObjectTextBounded.mockReset();
  getObjectBytesBounded.mockReset();
  putObjectText.mockReset();
});

describe("T7 — a lying sandbox cannot change the verdict", () => {
  it("records the hash of the uploaded bytes, not the one the artifact claims", async () => {
    // The attack: claim the deployed hash, upload anything.
    givenArtifact(artifact({ rebuilt_wasm_hash: DEPLOYED_HASH }));
    getObjectBytesBounded.mockResolvedValue({ bytes: HONEST_BYTES, size: HONEST_BYTES.byteLength });

    const { recorded, service } = harness();
    const outcome = await service.recordFromBatchTerminalState(REBUILD, { status: "SUCCEEDED" });

    expect(outcome.rebuiltWasmHash).toBe(HONEST_HASH);
    expect(outcome.rebuiltWasmHash).not.toBe(DEPLOYED_HASH);
    expect(recorded).toHaveLength(1);
    expect(recorded[0].rebuiltWasmHash).toBe(HONEST_HASH);

    // And the consequence that matters: the target the attacker aimed at comes out mismatched.
    const verdict = resolveJobVerdict({
      rebuild: { rebuiltWasmHash: recorded[0].rebuiltWasmHash, buildMode: "build" },
      freshDeployedHash: DEPLOYED_HASH,
      recordedHash: DEPLOYED_HASH,
    });
    expect(verdict.matched).toBe(false);
    expect(verdict.result.rebuilt_wasm_hash).toBe(HONEST_HASH);
  });

  it("still verifies a truthful rebuild — the field is not merely being ignored", async () => {
    // Same bytes, and this time the artifact tells the truth about them; the deployed hash is theirs.
    givenArtifact(artifact({ rebuilt_wasm_hash: HONEST_HASH }));
    getObjectBytesBounded.mockResolvedValue({ bytes: HONEST_BYTES, size: HONEST_BYTES.byteLength });

    const { recorded, service } = harness();
    await service.recordFromBatchTerminalState(REBUILD, { status: "SUCCEEDED" });

    expect(recorded[0].outcome).toBe("success");
    expect(recorded[0].rebuiltWasmHash).toBe(HONEST_HASH);

    const verdict = resolveJobVerdict({
      rebuild: { rebuiltWasmHash: recorded[0].rebuiltWasmHash, buildMode: "build" },
      freshDeployedHash: HONEST_HASH,
      recordedHash: HONEST_HASH,
    });
    expect(verdict.matched).toBe(true);
  });

  it("hashes the bytes even when the artifact reports no hash at all", async () => {
    givenArtifact(artifact());
    getObjectBytesBounded.mockResolvedValue({ bytes: HONEST_BYTES, size: HONEST_BYTES.byteLength });

    const { recorded, service } = harness();
    await service.recordFromBatchTerminalState(REBUILD, { status: "SUCCEEDED" });

    // The old code had nothing to record here and the job failed `comparison_not_available`.
    expect(recorded[0].rebuiltWasmHash).toBe(HONEST_HASH);
  });
});

describe("the bytes cannot be hashed — every path fails closed", () => {
  it("refuses to verdict from the reported hash when the object is absent", async () => {
    givenArtifact(artifact({ rebuilt_wasm_hash: DEPLOYED_HASH }));
    getObjectBytesBounded.mockResolvedValue(undefined);

    const { recorded, service } = harness();
    const outcome = await service.recordFromBatchTerminalState(REBUILD, { status: "SUCCEEDED" });

    expect(outcome.outcome).toBe("cli_failure");
    expect(outcome.errorCode).toBe("rebuilt_bytes_absent");
    // The critical assertion: the claimed hash is nowhere near what gets persisted.
    expect(recorded[0].rebuiltWasmHash).toBeUndefined();
    expect(JSON.stringify(recorded[0])).not.toContain(DEPLOYED_HASH);
  });

  it("refuses an object over the ceiling, and says so distinctly from absent", async () => {
    givenArtifact(artifact({ rebuilt_wasm_hash: DEPLOYED_HASH }));
    getObjectBytesBounded.mockResolvedValue({ tooLarge: MAX_BYTES + 1 });

    const { recorded, service } = harness();
    const outcome = await service.recordFromBatchTerminalState(REBUILD, { status: "SUCCEEDED" });

    expect(outcome.errorCode).toBe("rebuilt_bytes_too_large");
    expect(recorded[0].rebuiltWasmHash).toBeUndefined();
  });

  it("keeps a valid SandboxDiagnostics shape, since a failed row can still be read back", async () => {
    givenArtifact(artifact({ rebuilt_wasm_hash: DEPLOYED_HASH }));
    getObjectBytesBounded.mockResolvedValue(undefined);

    const { recorded, service } = harness();
    await service.recordFromBatchTerminalState(REBUILD, { status: "SUCCEEDED" });

    // `runner` is required on `SandboxDiagnostics`, and the artifact's own diagnostics were absent here.
    expect(recorded[0].diagnostics).toMatchObject({ runner: "docker_build_image_rebuild" });
    expect(String((recorded[0].diagnostics as { stderr_excerpt: string }).stderr_excerpt)).toContain(
      "No rebuilt Wasm at staging/",
    );
  });
});

describe("a cli_failure is not asked for bytes it never produced", () => {
  it("skips the fetch entirely", async () => {
    givenArtifact(
      artifact({ classification: "cli_failure", exit_code: 2, reason: "manifest_path_not_found" }),
    );

    const { recorded, service } = harness();
    const outcome = await service.recordFromBatchTerminalState(REBUILD, { status: "FAILED" });

    expect(outcome.outcome).toBe("cli_failure");
    expect(outcome.errorCode).toBe("manifest_path_not_found");
    // No wasted S3 round trip, and no chance of a stale object from an earlier attempt being hashed into a
    // rebuild that failed before it produced anything.
    expect(getObjectBytesBounded).not.toHaveBeenCalled();
    expect(recorded[0].rebuiltWasmHash).toBeUndefined();
  });
});

/**
 * `verification-svc`'s log route answers **502**, not 404, for a row that names an object that is not there
 * (`jobs.service.ts`: "the row points at an object that is not there — a real fault").
 */
describe("the build log's key is never recorded without its object", () => {
  it("records the key when the object was written", async () => {
    givenArtifact(artifact({ rebuilt_wasm_hash: HONEST_HASH, build_log: "$ cargo build\nok\n" }));
    getObjectBytesBounded.mockResolvedValue({ bytes: HONEST_BYTES, size: HONEST_BYTES.byteLength });
    putObjectText.mockResolvedValue(undefined);

    const { recorded, buildLogKeys, service } = harness();
    await service.recordFromBatchTerminalState(REBUILD, { status: "SUCCEEDED" });

    expect(putObjectText).toHaveBeenCalledTimes(1);
    expect(buildLogKeys).toEqual([
      { rebuildId: REBUILD.rebuildId, key: `build-logs/${REBUILD.rebuildId}/build.log` },
    ]);
    expect(recorded).toHaveLength(1);
  });

  it("★ records no key when the write failed, and still records the outcome", async () => {
    givenArtifact(artifact({ rebuilt_wasm_hash: HONEST_HASH, build_log: "$ cargo build\nboom\n" }));
    getObjectBytesBounded.mockResolvedValue({ bytes: HONEST_BYTES, size: HONEST_BYTES.byteLength });
    putObjectText.mockRejectedValue(new Error("AccessDenied"));

    const { recorded, buildLogKeys, service } = harness();
    await service.recordFromBatchTerminalState(REBUILD, { status: "SUCCEEDED" });

    expect(buildLogKeys).toEqual([]);
    // The half that stops this being a fail-closed diagnostic: the rebuild's outcome is unaffected.
    expect(recorded).toHaveLength(1);
  });

  it("writes nothing at all for an artifact carrying no log", async () => {
    givenArtifact(artifact({ rebuilt_wasm_hash: HONEST_HASH }));
    getObjectBytesBounded.mockResolvedValue({ bytes: HONEST_BYTES, size: HONEST_BYTES.byteLength });

    const { buildLogKeys, service } = harness();
    await service.recordFromBatchTerminalState(REBUILD, { status: "SUCCEEDED" });

    expect(putObjectText).not.toHaveBeenCalled();
    expect(buildLogKeys).toEqual([]);
  });
});
