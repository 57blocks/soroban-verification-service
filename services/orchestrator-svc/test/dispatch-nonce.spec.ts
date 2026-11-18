import { jest } from "@jest/globals";
import { BatchDispatchService } from "../src/modules/verification-pipeline/batch-dispatch.service.js";
import type { BuilderInvocationParams } from "../src/modules/verification-pipeline/builder-invocation.util.js";
import {
  canonicalSourceKey,
  isStagedSourceKey,
  paramsDocumentKey,
  rebuiltWasmKey,
  recipeArtifactKey,
} from "../src/common/staging-keys.util.js";

// Presigning signs locally; any credentials will do, and none may come from the developer's own profile.
delete process.env.AWS_PROFILE;
process.env.AWS_ACCESS_KEY_ID = "AKIAEXAMPLEEXAMPLE00";
process.env.AWS_SECRET_ACCESS_KEY = "example-secret-for-local-signing-only";

const REBUILD = "11111111-2222-3333-4444-555555555555";
const CONFIG: Record<string, unknown> = {
  stagingStorage: { bucket: "scvs-staging-test", region: "ap-southeast-2" },
  batchMaterialiseContainerName: "materialise",
  batchRunnerContainerName: "runner",
  batchDefaultArch: "amd64",
  batchJobQueueArns: { arm64: "arn:aws:batch:ap-southeast-2:111:job-queue/arm", amd64: "arn:aws:batch:ap-southeast-2:111:job-queue/x86" },
  batchJobDefinitionArns: { arm64: "example-builder-dev", amd64: "example-builder-dev-amd64" },
};

const PARAMS: BuilderInvocationParams = {
  rebuildId: REBUILD,
  target: { network: "testnet", wasm_hash: "8ecd1857496df2c15aaab4d18d2d7689542a62814245e9b2c613c609b86bd11c" },
  sourceRef: { type: "source_uri", source_uri: "https://example.test/s.tar.gz", source_sha256: "a".repeat(64), visibility: "public" } as never,
  imageDigest: `123456789012.dkr.ecr.ap-southeast-2.amazonaws.com/scvs-composed-environments@sha256:${"b".repeat(64)}`,
  imageArchitecture: "amd64",
};

function dispatcher() {
  const recorded: { batchJobId: string; dispatchNonce?: string }[] = [];
  const submitted: string[] = [];
  const service = new BatchDispatchService(
    { get: (key: string) => CONFIG[key] } as never,
    {} as never,
    { async markDispatched(_id: string, input: { batchJobId: string; dispatchNonce?: string }) { recorded.push(input); } } as never,
    {} as never,
  );
  const internals = service as unknown as {
    describeRegisteredDefinition: () => Promise<undefined>;
    submitToBatch: (batch: unknown, input: unknown) => Promise<{ jobId: string }>;
  };
  jest.spyOn(internals, "describeRegisteredDefinition").mockResolvedValue(undefined);
  jest.spyOn(internals, "submitToBatch").mockImplementation(async (_batch, input) => {
    submitted.push(JSON.stringify(input));
    return { jobId: `job-${submitted.length}` };
  });
  return { service, recorded, submitted };
}

describe("each dispatch of a rebuild writes under its own nonce", () => {
  it("records a fresh nonce with each dispatch, and presigns the job's outputs under it", async () => {
    const { service, recorded, submitted } = dispatcher();

    await service.submitBatchJob(PARAMS, "build");
    await service.submitBatchJob(PARAMS, "build");

    const [first, second] = recorded.map((entry) => entry.dispatchNonce!);
    expect(first).toMatch(/^[0-9a-f]{32}$/);
    expect(second).toMatch(/^[0-9a-f]{32}$/);
    expect(first).not.toBe(second);
    // A link the first job held names only the first dispatch's keys.
    for (const key of [recipeArtifactKey(REBUILD, "build", first), rebuiltWasmKey(REBUILD, "build", first), canonicalSourceKey(REBUILD, "build", first)]) {
      expect(submitted[0]).toContain(key);
      expect(submitted[1]).not.toContain(key);
    }
    expect(submitted[1]).toContain(recipeArtifactKey(REBUILD, "build", second));
  });
});

describe("staging keys", () => {
  it("keeps the old layout for a rebuild dispatched before nonces", () => {
    expect(recipeArtifactKey(REBUILD, "verify")).toBe(`staging/${REBUILD}/verify/recipe.json`);
    expect(rebuiltWasmKey(REBUILD, "verify")).toBe(`staging/${REBUILD}/verify/rebuilt.wasm`);
    expect(canonicalSourceKey(REBUILD, "verify")).toBe(`staging/${REBUILD}/verify/canonical-source`);
    expect(paramsDocumentKey(REBUILD, "verify", "runner")).toBe(`staging/${REBUILD}/verify/params/runner.json`);
  });

  it("puts a dispatch's own objects under its nonce", () => {
    expect(rebuiltWasmKey(REBUILD, "build", "ab12")).toBe(`staging/${REBUILD}/build/ab12/rebuilt.wasm`);
    expect(paramsDocumentKey(REBUILD, "build", "runner", "ab12")).toBe(`staging/${REBUILD}/build/ab12/params/runner.json`);
  });

  it("recognises a staged source copy under any mode and dispatch, and nothing else", () => {
    expect(isStagedSourceKey(`staging/${REBUILD}/build/fetched-source`)).toBe(true);
    expect(isStagedSourceKey(`staging/${REBUILD}/build/ab12/canonical-source`)).toBe(true);
    expect(isStagedSourceKey(`staging/${REBUILD}/build/ab12/rebuilt.wasm`)).toBe(false);
    expect(isStagedSourceKey(`staging/${REBUILD}/build/ab12/params/runner.json`)).toBe(false);
  });
});
