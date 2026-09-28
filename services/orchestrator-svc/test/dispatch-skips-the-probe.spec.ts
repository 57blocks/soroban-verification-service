import { jest } from "@jest/globals";
import { BatchDispatchService } from "../src/modules/verification-pipeline/batch-dispatch.service.js";
import type { BuilderInvocationParams } from "../src/modules/verification-pipeline/builder-invocation.util.js";
import type { ImagePlatformService } from "../src/modules/verification-pipeline/image-platform.service.js";

type ProbeStub = ImagePlatformService & { calls: number };

const probeStub = (): ProbeStub => {
  const stub = {
    calls: 0,
    async resolveArchitectures() {
      stub.calls += 1;
      return { architectures: [], resolvedFrom: "unresolved" as const };
    },
  };
  return stub as unknown as ProbeStub;
};

const CONFIG = {
  stagingStorage: { bucket: "scvs-staging-test", region: "ap-southeast-2" },
  batchMaterialiseContainerName: "materialise",
  batchRunnerContainerName: "runner",
  batchDefaultArch: "amd64" as const,
  batchJobQueueArns: {
    arm64: "arn:aws:batch:ap-southeast-2:111:job-queue/arm",
    amd64: "arn:aws:batch:ap-southeast-2:111:job-queue/x86",
  },
  batchJobDefinitionArns: {
    arm64: "scvs-builder-dev",
    amd64: "scvs-builder-dev-amd64",
  },
} as const;

const configStub = {
  get: (key: keyof typeof CONFIG) => CONFIG[key],
};

const BATCH_JOB_ID = "b0000000-0000-0000-0000-000000000000";

const dispatchWith = (probe: ProbeStub): BatchDispatchService => {
  const service = new BatchDispatchService(
    configStub as never,
    {} as never,
    { async markDispatched() {} } as never,
    probe,
  );
  const internals = service as unknown as {
    putParamsDocument: () => Promise<void>;
    describeRegisteredDefinition: () => Promise<undefined>;
    submitToBatch: () => Promise<{ jobId: string }>;
  };
  jest
    .spyOn(internals, "putParamsDocument")
    .mockRejectedValue(new Error("dispatch-skips-the-probe: putParamsDocument() was called; see dispatchWith()."));
  jest.spyOn(internals, "describeRegisteredDefinition").mockResolvedValue(undefined);
  jest.spyOn(internals, "submitToBatch").mockResolvedValue({ jobId: BATCH_JOB_ID });
  return service;
};

const PARAMS: BuilderInvocationParams = {
  rebuildId: "11111111-2222-3333-4444-555555555555",
  target: {
    network: "testnet",
    wasm_hash: "8ecd1857496df2c15aaab4d18d2d7689542a62814245e9b2c613c609b86bd11c",
  },
  sourceRef: {
    type: "hosted_tarball",
    tarball_url: "https://example.test/source.tar.gz",
    source_sha256: "a".repeat(64),
    visibility: "public",
  } as never,
  imageDigest: `123456789012.dkr.ecr.ap-southeast-2.amazonaws.com/scvs-composed-environments@sha256:${"b".repeat(64)}`,
};

describe("dispatch and the architecture probe", () => {
  it("CONTROL: probes when the environment recorded no architecture", async () => {
    const probe = probeStub();

    await expect(dispatchWith(probe).submitBatchJob(PARAMS, "build")).resolves.toBe(BATCH_JOB_ID);

    expect(probe.calls).toBe(1);
  });

  it("does not probe when the environment recorded one", async () => {
    const probe = probeStub();

    await expect(
      dispatchWith(probe).submitBatchJob({ ...PARAMS, imageArchitecture: "arm64" }, "build"),
    ).resolves.toBe(BATCH_JOB_ID);

    expect(probe.calls).toBe(0);
  });
});
