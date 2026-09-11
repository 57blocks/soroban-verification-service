import { BatchDispatchService } from "../src/modules/verification-pipeline/batch-dispatch.service.js";
import type { BuilderInvocationParams } from "../src/modules/verification-pipeline/builder-invocation.util.js";
import type { ImagePlatformService } from "../src/modules/verification-pipeline/image-platform.service.js";

/** The correctness of the routing is `queue-selection.spec.ts`'s job, on a pure function. */
type ProbeStub = ImagePlatformService & { calls: number };

const probeStub = (): ProbeStub => {
  const stub = {
    calls: 0,
    async resolveArchitectures() {
      stub.calls += 1;
      // Whatever a real probe would say is irrelevant; empty is what private ECR actually produces.
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
  // Both halves set, so neither the queue nor the family can be the thing that throws before the probe is
  // reached — this file's control case depends on getting all the way to AWS.
  batchJobDefinitionArns: {
    arm64: "scvs-builder-dev",
    amd64: "scvs-builder-dev-amd64",
  },
} as const;

const configStub = {
  get: (key: keyof typeof CONFIG) => CONFIG[key],
};

const dispatchWith = (probe: ProbeStub) =>
  new BatchDispatchService(
    configStub as never,
    {} as never,
    {} as never,
    probe,
  );

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

/** `submitBatchJob` will fail somewhere in AWS — presigning or SubmitJob. */
const attemptDispatch = async (probe: ProbeStub, params: BuilderInvocationParams): Promise<void> => {
  await dispatchWith(probe)
    .submitBatchJob(params, "build")
    .catch(() => undefined);
};

describe("dispatch and the architecture probe", () => {
  it("CONTROL: probes when the environment recorded no architecture", async () => {
    // If this ever reports 0, the treatment case below is vacuous — see this file's header.
    const probe = probeStub();
    await attemptDispatch(probe, PARAMS);

    expect(probe.calls).toBe(1);
  });

  it("does not probe when the environment recorded one", async () => {
    const probe = probeStub();
    await attemptDispatch(probe, { ...PARAMS, imageArchitecture: "arm64" });

    expect(probe.calls).toBe(0);
  });
});
