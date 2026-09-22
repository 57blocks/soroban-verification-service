import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { jest } from "@jest/globals";
import type { ConfigService } from "@nestjs/config";
import type {
  JobsRepository,
  MarkRebuildTerminalInput,
  RebuildRecord,
  RebuildsRepository,
} from "@scvs/db";
import type { AppConfigService } from "../src/config/configuration.js";

/**
 * A `recipe.json` this orchestrator cannot use must become a terminal, visible failure in one tick — never an
 * exception.
 */

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
  // Reached through `source-resolution`'s surface: this service now imports the module rather than one
  // file inside it, so the stub covers what that module uses too.
  deleteObject: async () => undefined,
  getObjectBytes: async () => undefined,
  presignGetUrl: async () => "https://example.invalid/get",
  putObjectBytes: async () => undefined,
}));

const { RebuildOutcomeService } = await import(
  "../src/modules/batch-events/rebuild-outcome.service.js"
);

const CORPUS = new URL("../../../packages/core/contract/corpus/", import.meta.url).pathname;
const corpus = (name: string) => readFileSync(`${CORPUS}${name}`, "utf8");

const REBUILT_BYTES = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
const MAX_BYTES = 16 * 1024 * 1024;

const CORPUS_SOURCE_SHA256 = "ecf4bc7db300358330af9bc1a272267f1c870a849b68db0f768bcea4b6078533";

const REBUILD: RebuildRecord = {
  rebuildId: "6429588a-1d6a-4ba1-88ce-f908765c35c5",
  idempotencyKey: "k".repeat(64),
  sourceRef: {
    type: "public_tarball",
    visibility: "public",
    tarball_sha256: "b".repeat(64),
    source_sha256: CORPUS_SOURCE_SHA256,
  },
  buildOptions: [],
  imageDigest: `docker.io/stellar/stellar-cli@sha256:${"c".repeat(64)}`,
  status: "running",
  buildMode: "build",
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
};

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
  const jobs = {
    recordBuildLogKeyForRebuild: async () => 1,
  } as unknown as JobsRepository;
  return { recorded, service: new RebuildOutcomeService(configService, rebuilds, jobs) };
}

beforeEach(() => {
  getObjectTextBounded.mockReset();
  getObjectBytesBounded.mockReset();
  putObjectText.mockReset();
  getObjectBytesBounded.mockResolvedValue({ bytes: REBUILT_BYTES, size: REBUILT_BYTES.byteLength });
});

describe("a newer orchestrator reads every older builder's artifact", () => {
  it("records the pre-versioning document that wedged staging as the success it is", async () => {
    getObjectTextBounded.mockResolvedValue({ text: corpus("v0.0/success-version-alignment.json") });

    const { recorded, service } = harness();
    const outcome = await service.recordFromBatchTerminalState(REBUILD, { status: "SUCCEEDED" });

    expect(outcome.outcome).toBe("success");
    expect(outcome.errorCode).toBeUndefined();
    expect(recorded[0].outcome).toBe("success");
    expect(recorded[0].rebuiltWasmHash).toBe(createHash("sha256").update(REBUILT_BYTES).digest("hex"));
  });

  it("reads the current version's own corpus the same way", async () => {
    getObjectTextBounded.mockResolvedValue({ text: corpus("v1.0/success-version-alignment.json") });

    const { recorded, service } = harness();
    const outcome = await service.recordFromBatchTerminalState(REBUILD, { status: "SUCCEEDED" });

    expect(outcome.outcome).toBe("success");
    expect(recorded[0].outcome).toBe("success");
  });
});

describe("an artifact this orchestrator cannot use fails terminally, in one tick", () => {
  /** The forward direction: a builder deployed ahead of this orchestrator. */
  it("records artifact_schema_unsupported for a higher contract MAJOR", async () => {
    const ahead = { ...JSON.parse(corpus("v1.0/success-version-alignment.json")), schema_version: "2.0" };
    getObjectTextBounded.mockResolvedValue({ text: JSON.stringify(ahead) });

    const { recorded, service } = harness();
    const outcome = await service.recordFromBatchTerminalState(REBUILD, { status: "SUCCEEDED" });

    expect(outcome.outcome).toBe("cli_failure");
    expect(outcome.errorCode).toBe("artifact_schema_unsupported");
    expect(recorded).toHaveLength(1);
    expect(recorded[0].errorCode).toBe("artifact_schema_unsupported");
    // The reason has to be readable by whoever is paged, not just machine-matchable.
    expect(String((recorded[0].diagnostics as { stderr_excerpt?: string }).stderr_excerpt)).toContain(
      "Deploy this environment's orchestrator before its builder",
    );
  });

  it("records artifact_unreadable for a document that does not conform to the version it declares", async () => {
    const wrong = JSON.parse(corpus("v1.0/success-version-alignment.json"));
    wrong.classification = "something_new";
    delete wrong.runner;
    getObjectTextBounded.mockResolvedValue({ text: JSON.stringify(wrong) });

    const { recorded, service } = harness();
    const outcome = await service.recordFromBatchTerminalState(REBUILD, { status: "SUCCEEDED" });

    expect(outcome.outcome).toBe("cli_failure");
    expect(outcome.errorCode).toBe("artifact_unreadable");
    expect(recorded[0].errorCode).toBe("artifact_unreadable");
  });

  it("records artifact_unreadable for bytes that are not an artifact at all", async () => {
    getObjectTextBounded.mockResolvedValue({ text: "<html>404</html>" });

    const { service } = harness();
    const outcome = await service.recordFromBatchTerminalState(REBUILD, { status: "SUCCEEDED" });

    expect(outcome.outcome).toBe("cli_failure");
    expect(outcome.errorCode).toBe("artifact_unreadable");
  });

  /**
   * The reconciler's rung 2. Returning `true` is what ends the loop: `false` would leave the rebuild `running`
   * and the scan would ask again in 60 seconds, forever, which is the observed failure.
   */
  it("lets the reconciler settle an unusable artifact instead of retrying it every minute", async () => {
    const ahead = { ...JSON.parse(corpus("v1.0/success-version-alignment.json")), schema_version: "3.0" };
    getObjectTextBounded.mockResolvedValue({ text: JSON.stringify(ahead) });

    const { recorded, service } = harness();
    await expect(service.tryRecordFromArtifact(REBUILD)).resolves.toBe(true);
    expect(recorded[0].errorCode).toBe("artifact_schema_unsupported");
  });
});
