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
import type { AppConfigService } from "../src/config/configuration.js";

const getObjectTextBounded = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const getObjectBytesBounded = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const putObjectText = jest.fn<(...args: unknown[]) => Promise<void>>();

jest.unstable_mockModule("@scvs/aws", () => ({
  createS3Client: () => ({}),
  getObjectTextBounded,
  getObjectBytesBounded,
  putObjectText,
  createBatchClient: () => ({}),
  describeJob: async () => undefined,
  presignPutUrl: async () => "https://example.invalid/put",
  submitJob: async () => "batch-job-1",
  deleteObject: async () => undefined,
  getObjectBytes: async () => undefined,
  presignGetUrl: async () => "https://example.invalid/get",
  putObjectBytes: async () => undefined,
}));

const { RebuildOutcomeService } = await import(
  "../src/modules/batch-events/rebuild-outcome.service.js"
);

const REBUILD_ID = "11111111-2222-3333-4444-555555555555";
const SUBMITTED_SHA = "a".repeat(64);

const WASM_BYTES = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

const CANONICAL_BYTES = new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0xca, 0xfe, 0xba, 0xbe]);
const CANONICAL_SHA = createHash("sha256").update(CANONICAL_BYTES).digest("hex");

const REBUILD: RebuildRecord = {
  rebuildId: REBUILD_ID,
  idempotencyKey: "k".repeat(64),
  sourceRef: {
    type: "private_tarball",
    visibility: "public",
    tarball_sha256: SUBMITTED_SHA,
    source_sha256: SUBMITTED_SHA,
  },
  buildOptions: [],
  imageDigest: `docker.io/stellar/stellar-cli@sha256:${"c".repeat(64)}`,
  status: "running",
  buildMode: "verify",
  mechanismReason: "on_chain_recipe_in_trusted_image",
  createdAt: "2026-08-27T00:00:00.000Z",
  updatedAt: "2026-08-27T00:00:00.000Z",
};

const CANONICAL_KEY = `staging/${REBUILD_ID}/verify/canonical-source`;
const WASM_KEY = `staging/${REBUILD_ID}/verify/rebuilt.wasm`;

function artifact(canonicalisation?: BuildArtifact["source_canonicalisation"]): string {
  return JSON.stringify({
    recipe: {
      image: REBUILD.imageDigest,
      workspace_path: ".",
      target: "wasm32v1-none",
      bldarg: ["contract", "build"],
      bldopt: [],
    },
    runner: "stellar_contract_verify",
    built_at: "2026-08-27T00:00:00.000Z",
    exit_code: 0,
    classification: "success",
    rebuilt_wasm_uploaded: true,
    source_sha256: SUBMITTED_SHA,
    ...(canonicalisation ? { source_canonicalisation: canonicalisation } : {}),
  });
}

function givenObjects(objects: Record<string, Uint8Array | undefined>): void {
  getObjectBytesBounded.mockImplementation(async (...args: unknown[]) => {
    const key = args[2] as string;
    const bytes = objects[key];
    return bytes ? { bytes, size: bytes.byteLength } : undefined;
  });
}

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
          ? 16 * 1024 * 1024
          : undefined,
  } as unknown as AppConfigService & ConfigService;
  const jobs = {
    recordBuildLogKeyForRebuild: async () => 1,
  } as unknown as JobsRepository;
  return { recorded, service: new RebuildOutcomeService(configService, rebuilds, jobs) };
}

const PEELED = {
  depth: 1,
  outer_format: "zip",
  canonical_format: "gzip",
  reconstruction: "not_attempted" as const,
  uploaded: true,
};

beforeEach(() => {
  getObjectTextBounded.mockReset();
  getObjectBytesBounded.mockReset();
  putObjectText.mockReset();
});

describe("the canonical source archive's hash is ours, not the sandbox's", () => {
  it("records the hash of the uploaded bytes, not the one the artifact claims", async () => {
    getObjectTextBounded.mockResolvedValue({
      text: artifact({ ...PEELED, canonical_sha256: SUBMITTED_SHA }),
    });
    givenObjects({ [WASM_KEY]: WASM_BYTES, [CANONICAL_KEY]: CANONICAL_BYTES });

    const { recorded, service } = harness();
    const outcome = await service.recordFromBatchTerminalState(REBUILD, { status: "SUCCEEDED" });

    expect(outcome.outcome).toBe("success");
    expect(outcome.canonicalSourceSha256).toBe(CANONICAL_SHA);
    expect(outcome.canonicalSourceSha256).not.toBe(SUBMITTED_SHA);
    expect(recorded[0].canonicalSourceSha256).toBe(CANONICAL_SHA);
    expect(recorded[0].canonicalSourceKey).toBe(CANONICAL_KEY);
    expect(recorded[0].sourceCanonicalisation).toMatchObject({ depth: 1, outer_format: "zip" });
  });

  it("hashes an honest report to the same value — the field is not merely being ignored", async () => {
    getObjectTextBounded.mockResolvedValue({
      text: artifact({ ...PEELED, canonical_sha256: CANONICAL_SHA }),
    });
    givenObjects({ [WASM_KEY]: WASM_BYTES, [CANONICAL_KEY]: CANONICAL_BYTES });

    const { recorded, service } = harness();
    await service.recordFromBatchTerminalState(REBUILD, { status: "SUCCEEDED" });

    expect(recorded[0].canonicalSourceSha256).toBe(CANONICAL_SHA);
  });

  it("fails the rebuild when the sandbox claims an upload and there is no object", async () => {
    getObjectTextBounded.mockResolvedValue({
      text: artifact({ ...PEELED, canonical_sha256: CANONICAL_SHA }),
    });
    givenObjects({ [WASM_KEY]: WASM_BYTES, [CANONICAL_KEY]: undefined });

    const { recorded, service } = harness();
    const outcome = await service.recordFromBatchTerminalState(REBUILD, { status: "SUCCEEDED" });

    expect(outcome.outcome).toBe("cli_failure");
    expect(outcome.errorCode).toBe("source_archive_canonical_unavailable");
    expect(outcome.canonicalSourceSha256).toBeUndefined();
    expect(recorded[0].canonicalSourceSha256).toBeUndefined();
  });

  it("fetches nothing when the canonical archive is the submitted archive", async () => {
    getObjectTextBounded.mockResolvedValue({ text: artifact() });
    givenObjects({ [WASM_KEY]: WASM_BYTES });

    const { recorded, service } = harness();
    const outcome = await service.recordFromBatchTerminalState(REBUILD, { status: "SUCCEEDED" });

    expect(outcome.outcome).toBe("success");
    expect(outcome.canonicalSourceSha256).toBeUndefined();
    expect(recorded[0].canonicalSourceKey).toBeUndefined();
    const keys = getObjectBytesBounded.mock.calls.map((call) => call[2]);
    expect(keys).toEqual([WASM_KEY]);
  });

  it("does not fetch a canonical archive the sandbox says it did not upload", async () => {
    getObjectTextBounded.mockResolvedValue({
      text: artifact({ ...PEELED, uploaded: false, canonical_sha256: CANONICAL_SHA }),
    });
    givenObjects({ [WASM_KEY]: WASM_BYTES, [CANONICAL_KEY]: CANONICAL_BYTES });

    const { recorded, service } = harness();
    await service.recordFromBatchTerminalState(REBUILD, { status: "SUCCEEDED" });

    expect(recorded[0].canonicalSourceSha256).toBeUndefined();
    expect(getObjectBytesBounded.mock.calls.map((call) => call[2])).toEqual([WASM_KEY]);
  });
});
