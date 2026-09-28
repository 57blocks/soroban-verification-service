import { BatchJobParams, MaterialiseJobParams, parseDto } from "@scvs/core";
import type { RegisteredTaskProperties } from "@scvs/aws";
import {
  builderContainerParams,
  type BuilderInvocationParams,
} from "../src/modules/verification-pipeline/builder-invocation.util.js";
import {
  assertWithinTaskPropertiesLimit,
  measureMergedTaskProperties,
  TASKPROPERTIES_LIMIT_BYTES,
  TASKPROPERTIES_SAFETY_MARGIN_BYTES,
  TaskPropertiesTooLargeError,
} from "../src/modules/verification-pipeline/taskproperties-size.util.js";

const presigned = (key: string): string =>
  `https://sv-dev-scratch.s3.ap-southeast-2.amazonaws.com/${key}` +
  "?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Content-Sha256=UNSIGNED-PAYLOAD" +
  "&X-Amz-Credential=ASIAEXAMPLEEXAMPLE%2F20260810%2Fap-southeast-2%2Fs3%2Faws4_request" +
  "&X-Amz-Date=20260810T000000Z&X-Amz-Expires=3600&X-Amz-SignedHeaders=host" +
  `&X-Amz-Security-Token=${"T".repeat(1400)}&X-Amz-Signature=${"s".repeat(64)}&x-id=PutObject`;

const presignedStaging = (key: string): string =>
  `https://sv-staging-scratch.s3.ap-southeast-2.amazonaws.com/${key}` +
  "?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Content-Sha256=UNSIGNED-PAYLOAD" +
  "&X-Amz-Credential=ASIAEXAMPLEEXAMPLE2%2F20260822%2Fap-southeast-2%2Fs3%2Faws4_request" +
  "&X-Amz-Date=20260822T000000Z&X-Amz-Expires=3600&X-Amz-SignedHeaders=host" +
  `&X-Amz-Security-Token=${"T".repeat(1416)}&X-Amz-Signature=${"s".repeat(64)}&x-id=PutObject`;

const UPLOAD_URL = presignedStaging("staging/rebuild-1/verify/recipe.json");
const ARTIFACT_UPLOAD_URL = presignedStaging("staging/rebuild-1/verify/rebuilt.wasm");
const CANONICAL_SOURCE_UPLOAD_URL = presignedStaging("staging/rebuild-1/verify/canonical-source");
const SOURCE_URI = presignedStaging("staging/uploads/upload-1/source.tar.gz");

const invocation: BuilderInvocationParams = {
  rebuildId: "11111111-2222-3333-4444-555555555555",
  target: {
    network: "testnet",
    contract_id: "CDFI5WMI7VA6YO5TKM7AI4CGQGYYT45UDQFMDKGN5Q22S2SLCI6RT4RM",
    wasm_hash: "a".repeat(64),
  },
  sourceRef: {
    type: "private_tarball",
    visibility: "private",
    tarball_sha256: "b".repeat(64),
    upload_id: "66666666-7777-8888-9999-000000000000",
    source_uri: SOURCE_URI,
  },
  imageDigest: `123456789012.dkr.ecr.ap-southeast-2.amazonaws.com/sv-staging-composed-environments@sha256:${"c".repeat(64)}`,
  buildOptions: ["--package", "hello-world"],
  expectedSourceSha256: "f".repeat(64),
  metadataReplay: [
    "cliver=22.0.1",
    "rsver=1.81.0",
    "rsenv=hello-world",
    "bldarg=--package hello-world",
    "bldopt=--package hello-world",
  ],
};

const REGISTERED_TASK_PROPERTIES: RegisteredTaskProperties = {
  revision: 14,
  taskProperties: [
    {
      volumes: [
        { name: "docker-sock", host: { sourcePath: "/var/run/docker.sock" } },
        { name: "scvs-shared", host: { sourcePath: "/tmp" } },
      ],
      containers: [
        {
          name: "materialise",
          image: `123456789012.dkr.ecr.ap-southeast-2.amazonaws.com/sv-staging-builder@sha256:${"d".repeat(64)}`,
          command: ["node", "services/builder/dist/materialise-entrypoint.js"],
          essential: false,
          resourceRequirements: [
            { type: "VCPU", value: "1" },
            { type: "MEMORY", value: "1700" },
          ],
          environment: [
            { name: "XDG_DATA_HOME", value: "/tmp" },
            { name: "SCVS_HANDOFF_ROOT", value: "/tmp" },
          ],
          mountPoints: [
            { sourceVolume: "scvs-shared", containerPath: "/tmp", readOnly: false },
          ],
        },
        {
          name: "runner",
          image: `123456789012.dkr.ecr.ap-southeast-2.amazonaws.com/sv-staging-builder@sha256:${"d".repeat(64)}`,
          command: ["node", "services/builder/dist/entrypoint.js"],
          essential: true,
          dependsOn: [{ containerName: "materialise", condition: "SUCCESS" }],
          resourceRequirements: [
            { type: "VCPU", value: "1" },
            { type: "MEMORY", value: "1700" },
          ],
          environment: [
            { name: "XDG_DATA_HOME", value: "/tmp" },
            { name: "SCVS_HANDOFF_ROOT", value: "/tmp" },
          ],
          mountPoints: [
            { sourceVolume: "docker-sock", containerPath: "/var/run/docker.sock", readOnly: false },
            { sourceVolume: "scvs-shared", containerPath: "/tmp", readOnly: false },
          ],
        },
      ],
    },
  ],
};

describe("builderContainerParams", () => {
  const { materialise, runner } = builderContainerParams(
    invocation,
    "verify",
    UPLOAD_URL,
    ARTIFACT_UPLOAD_URL,
    CANONICAL_SOURCE_UPLOAD_URL,
  );

  it("hands each half only what it may do", () => {
    expect(materialise).toEqual({
      job_id: invocation.rebuildId,
      source_ref: invocation.sourceRef,
      mode: "verify",
      expected_source_sha256: invocation.expectedSourceSha256,
      canonical_source_upload_url: CANONICAL_SOURCE_UPLOAD_URL,
    });
    expect(JSON.stringify(materialise)).not.toContain(UPLOAD_URL);
    expect(JSON.stringify(materialise)).not.toContain(ARTIFACT_UPLOAD_URL);
    expect(JSON.stringify(runner)).not.toContain(CANONICAL_SOURCE_UPLOAD_URL);
  });

  it("hands the runner no source_uri — it reads the fetched location from the handoff", () => {
    expect(runner.source_ref).not.toHaveProperty("source_uri");
    expect(JSON.stringify(runner)).not.toContain(SOURCE_URI);
    expect(runner.source_ref).toMatchObject({
      type: "private_tarball",
      tarball_sha256: "b".repeat(64),
      upload_id: "66666666-7777-8888-9999-000000000000",
    });
    expect(runner.upload_url).toBe(UPLOAD_URL);
    expect(runner.metadata_replay).toEqual(invocation.metadataReplay);
  });

  it("hands the runner both write targets — the rebuilt bytes are what the verdict rests on (TB3)", () => {
    expect(runner.artifact_upload_url).toBe(ARTIFACT_UPLOAD_URL);
    expect(runner.artifact_upload_url).not.toBe(runner.upload_url);
  });

  it("produces documents each half still validates against its own DTO", () => {
    expect(() => parseDto(MaterialiseJobParams, JSON.parse(JSON.stringify(materialise)))).not.toThrow();
    expect(() => parseDto(BatchJobParams, JSON.parse(JSON.stringify(runner)))).not.toThrow();
  });

  it("no longer fits Batch's 8192-byte ceiling inline, and does fit through the staged transport", () => {
    const override = {
      taskProperties: [
        {
          containers: [
            {
              name: "materialise",
              environment: [{ name: "SCVS_JOB_PARAMS_JSON", value: JSON.stringify(materialise) }],
            },
            {
              name: "runner",
              environment: [{ name: "SCVS_JOB_PARAMS_JSON", value: JSON.stringify(runner) }],
            },
          ],
        },
      ],
    };
    expect(Buffer.byteLength(JSON.stringify(override))).toBeGreaterThan(8192);

    const staged = {
      taskProperties: [
        {
          containers: [
            {
              name: "materialise",
              environment: [{ name: "SCVS_JOB_PARAMS_URL", value: presignedStaging("staging/rebuild-1/verify/params/materialise.json") }],
            },
            {
              name: "runner",
              environment: [{ name: "SCVS_JOB_PARAMS_URL", value: presignedStaging("staging/rebuild-1/verify/params/runner.json") }],
            },
          ],
        },
      ],
    };
    expect(Buffer.byteLength(JSON.stringify(staged))).toBeLessThan(8192);

    const duplicated = JSON.stringify({
      ...invocation,
      mode: "verify",
      upload_url: UPLOAD_URL,
      artifact_upload_url: ARTIFACT_UPLOAD_URL,
      source_ref: invocation.sourceRef,
    });
    expect(Buffer.byteLength(duplicated) * 2).toBeGreaterThan(8192);
  });

  it("★ has no room for a third presigned URL — which is why the build log travels in recipe.json", () => {
    const withLogUrl = {
      taskProperties: [
        {
          containers: [
            {
              name: "materialise",
              environment: [{ name: "SCVS_JOB_PARAMS_JSON", value: JSON.stringify(materialise) }],
            },
            {
              name: "runner",
              environment: [
                {
                  name: "SCVS_JOB_PARAMS_JSON",
                  value: JSON.stringify({
                    ...runner,
                    build_log_upload_url: presigned("build-logs/rebuild-1/verify.log"),
                  }),
                },
              ],
            },
          ],
        },
      ],
    };

    expect(Buffer.byteLength(JSON.stringify(withLogUrl))).toBeGreaterThan(8192);
  });

  it("leaves the override untouched, because the log goes out on the artifact", () => {
    expect(runner).not.toHaveProperty("build_log_upload_url");
    expect(JSON.stringify(runner)).not.toContain("build-logs/");
  });
});

describe("the merged taskProperties payload, measured the way AWS validates it", () => {
  const { materialise, runner } = builderContainerParams(
    invocation,
    "verify",
    UPLOAD_URL,
    ARTIFACT_UPLOAD_URL,
    CANONICAL_SOURCE_UPLOAD_URL,
  );

  const inlineContainers = [
    {
      name: "materialise",
      environment: [{ name: "SCVS_JOB_PARAMS_JSON", value: JSON.stringify(materialise) }],
    },
    {
      name: "runner",
      environment: [{ name: "SCVS_JOB_PARAMS_JSON", value: JSON.stringify(runner) }],
    },
  ];

  const urlContainers = [
    {
      name: "materialise",
      environment: [
        {
          name: "SCVS_JOB_PARAMS_URL",
          value: presignedStaging("staging/rebuild-1/verify/params/materialise.json"),
        },
      ],
    },
    {
      name: "runner",
      environment: [
        {
          name: "SCVS_JOB_PARAMS_URL",
          value: presignedStaging("staging/rebuild-1/verify/params/runner.json"),
        },
      ],
    },
  ];

  it(
    "the inline transport, at production-sized URLs, trips the pre-submit guard — " +
      "this is the staging rejection, made to fail before submission",
    () => {
      const measurement = measureMergedTaskProperties(inlineContainers, REGISTERED_TASK_PROPERTIES);
      expect(measurement.totalBytes).toBeGreaterThan(
        TASKPROPERTIES_LIMIT_BYTES - TASKPROPERTIES_SAFETY_MARGIN_BYTES,
      );
      expect(() => assertWithinTaskPropertiesLimit(measurement)).toThrow(TaskPropertiesTooLargeError);
    },
  );

  it("the presigned_url transport keeps the same recipe well clear of the guard", () => {
    const measurement = measureMergedTaskProperties(urlContainers, REGISTERED_TASK_PROPERTIES);
    expect(() => assertWithinTaskPropertiesLimit(measurement)).not.toThrow();
    expect(measurement.totalBytes).toBeLessThan(
      TASKPROPERTIES_LIMIT_BYTES - TASKPROPERTIES_SAFETY_MARGIN_BYTES,
    );
    expect(JSON.stringify(urlContainers)).not.toContain("metadata_replay");
    expect(JSON.stringify(urlContainers)).not.toContain(invocation.rebuildId);
  });

  it("the static half is the blind spot the old overrides_bytes log had", () => {
    const measurement = measureMergedTaskProperties(inlineContainers, REGISTERED_TASK_PROPERTIES);
    expect(measurement.staticBytes).toBeGreaterThan(1200);
    expect(measurement.totalBytes).toBeGreaterThan(measurement.overrideBytes);
    try {
      assertWithinTaskPropertiesLimit(measurement);
      throw new Error("expected the guard to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(TaskPropertiesTooLargeError);
      const message = (error as Error).message;
      expect(message).toContain("bytes");
      expect(message).not.toContain("X-Amz-");
    }
  });
});

describe("no mainnet RPC endpoint reaches either container", () => {
  const RPC_URL = "https://mainnet.sorobanrpc.com";
  const mainnet: BuilderInvocationParams = {
    ...invocation,
    target: { ...invocation.target, network: "mainnet" },
  };

  it.each(["build", "verify"] as const)(
    "the runner document carries no rpc_url in %s mode, and still validates",
    (mode) => {
      const { runner } = builderContainerParams(mainnet, mode, UPLOAD_URL, ARTIFACT_UPLOAD_URL);
      expect(runner).not.toHaveProperty("rpc_url");
      expect(() => parseDto(BatchJobParams, JSON.parse(JSON.stringify(runner)))).not.toThrow();
    },
  );

  it("the materialiser document carries none either", () => {
    const { materialise } = builderContainerParams(mainnet, "build", UPLOAD_URL, ARTIFACT_UPLOAD_URL);
    expect(materialise).not.toHaveProperty("rpc_url");
  });

  it("a mainnet job differs from a testnet one by its network and nothing else", () => {
    const testnet = builderContainerParams(invocation, "build", UPLOAD_URL, ARTIFACT_UPLOAD_URL);
    const onMainnet = builderContainerParams(mainnet, "build", UPLOAD_URL, ARTIFACT_UPLOAD_URL);
    const asTestnet = (params: typeof onMainnet.runner) =>
      JSON.stringify({ ...params, target: { ...params.target, network: "testnet" } });

    expect(asTestnet(onMainnet.runner)).toBe(asTestnet(testnet.runner));
    expect(JSON.stringify(onMainnet.materialise)).toBe(JSON.stringify(testnet.materialise));
    expect(JSON.stringify(onMainnet.runner)).not.toContain(RPC_URL);
  });
});
