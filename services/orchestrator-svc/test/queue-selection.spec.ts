import { isConfigurationError } from "../src/config/configuration-error.js";
import { selectJobQueue } from "../src/modules/verification-pipeline/queue-selection.util.js";

const ARM_QUEUE = "arn:aws:batch:ap-southeast-2:111:job-queue/arm";
const X86_QUEUE = "arn:aws:batch:ap-southeast-2:111:job-queue/x86";
const BOTH = { arm64: ARM_QUEUE, amd64: X86_QUEUE };

const ARM_DEF = "scvs-builder-dev";
const AMD_DEF = "scvs-builder-dev-amd64";
const DEFS = { arm64: ARM_DEF, amd64: AMD_DEF };

describe("selectJobQueue", () => {
  it("lets a single-architecture image choose the queue, ignoring the default", () => {
    expect(
      selectJobQueue({ architectures: ["amd64"], defaultArch: "arm64", queueArns: BOTH, jobDefinitions: DEFS })
    ).toEqual({
      arch: "amd64",
      jobQueueArn: X86_QUEUE,
      jobDefinition: AMD_DEF,
      reason: "image_single_arch",
    });

    expect(
      selectJobQueue({ architectures: ["arm64"], defaultArch: "amd64", queueArns: BOTH, jobDefinitions: DEFS })
    ).toEqual({
      arch: "arm64",
      jobQueueArn: ARM_QUEUE,
      jobDefinition: ARM_DEF,
      reason: "image_single_arch",
    });
  });

  it("breaks a multi-architecture tie with the configured default", () => {
    expect(
      selectJobQueue({ architectures: ["amd64", "arm64"], defaultArch: "arm64", queueArns: BOTH, jobDefinitions: DEFS })
    ).toEqual({
      arch: "arm64",
      jobQueueArn: ARM_QUEUE,
      jobDefinition: ARM_DEF,
      reason: "image_multi_arch_default",
    });

    expect(
      selectJobQueue({ architectures: ["arm64", "amd64"], defaultArch: "amd64", queueArns: BOTH, jobDefinitions: DEFS })
    ).toEqual({
      arch: "amd64",
      jobQueueArn: X86_QUEUE,
      jobDefinition: AMD_DEF,
      reason: "image_multi_arch_default",
    });
  });

  it("falls back to the default when the registry could not establish an architecture", () => {
    expect(
      selectJobQueue({ architectures: [], defaultArch: "arm64", queueArns: BOTH, jobDefinitions: DEFS })
    ).toEqual({
      arch: "arm64",
      jobQueueArn: ARM_QUEUE,
      jobDefinition: ARM_DEF,
      reason: "image_arch_unresolved_default",
    });
  });

  it("treats a repeated architecture as a single one", () => {
    expect(
      selectJobQueue({ architectures: ["arm64", "arm64"], defaultArch: "amd64", queueArns: BOTH, jobDefinitions: DEFS })
    ).toMatchObject({ arch: "arm64", reason: "image_single_arch" });
  });

  it("stays deterministic when the image runs on several architectures but not the default", () => {
    expect(
      selectJobQueue({
        architectures: ["amd64", "amd64"],
        defaultArch: "arm64",
        queueArns: BOTH,
        jobDefinitions: DEFS,
      })
    ).toMatchObject({ arch: "amd64" });
  });

  it("throws naming the missing variable rather than using the other architecture's queue", () => {
    expect(() =>
      selectJobQueue({
        architectures: ["amd64"],
        defaultArch: "arm64",
        queueArns: { arm64: ARM_QUEUE, amd64: undefined },
        jobDefinitions: DEFS,
      })
    ).toThrow(/SCVS_BATCH_JOB_QUEUE_ARN_AMD64/);

    expect(() =>
      selectJobQueue({
        architectures: [],
        defaultArch: "arm64",
        queueArns: { arm64: undefined, amd64: X86_QUEUE },
        jobDefinitions: DEFS,
      })
    ).toThrow(/SCVS_BATCH_JOB_QUEUE_ARN_ARM64/);
  });
});

describe("selectJobQueue — the builder job definition", () => {
  it("returns the family belonging to the same architecture as the queue", () => {
    for (const architectures of [["arm64"], ["amd64"]] as const) {
      const selected = selectJobQueue({
        architectures: [...architectures],
        defaultArch: "arm64",
        queueArns: BOTH,
        jobDefinitions: DEFS,
      });
      expect(selected.jobQueueArn).toBe(BOTH[selected.arch]);
      expect(selected.jobDefinition).toBe(DEFS[selected.arch]);
    }
  });

  it("throws naming the missing variable rather than dispatching the other architecture's family", () => {
    expect(() =>
      selectJobQueue({
        architectures: ["amd64"],
        defaultArch: "arm64",
        queueArns: BOTH,
        jobDefinitions: { arm64: ARM_DEF, amd64: undefined },
      })
    ).toThrow(/SCVS_BATCH_JOB_DEFINITION_ARN_AMD64/);

    expect(() =>
      selectJobQueue({
        architectures: ["arm64"],
        defaultArch: "arm64",
        queueArns: BOTH,
        jobDefinitions: { arm64: undefined, amd64: AMD_DEF },
      })
    ).toThrow(/SCVS_BATCH_JOB_DEFINITION_ARN_ARM64/);
  });

  it("reports a missing variable as a ConfigurationError, so the job is not retried", () => {
    for (const jobDefinitions of [
      { arm64: ARM_DEF, amd64: undefined },
      { arm64: undefined, amd64: AMD_DEF },
    ]) {
      let thrown: unknown;
      try {
        selectJobQueue({
          architectures: jobDefinitions.amd64 ? ["arm64"] : ["amd64"],
          defaultArch: "arm64",
          queueArns: BOTH,
          jobDefinitions,
        });
      } catch (error) {
        thrown = error;
      }
      expect(isConfigurationError(thrown)).toBe(true);
    }
  });

  it("reports a missing queue ARN as a ConfigurationError too", () => {
    let thrown: unknown;
    try {
      selectJobQueue({
        architectures: ["amd64"],
        defaultArch: "arm64",
        queueArns: { arm64: ARM_QUEUE, amd64: undefined },
        jobDefinitions: DEFS,
      });
    } catch (error) {
      thrown = error;
    }
    expect(isConfigurationError(thrown)).toBe(true);
  });

  it("checks the queue before the job definition when both are missing", () => {
    expect(() =>
      selectJobQueue({
        architectures: ["amd64"],
        defaultArch: "arm64",
        queueArns: { arm64: ARM_QUEUE, amd64: undefined },
        jobDefinitions: { arm64: ARM_DEF, amd64: undefined },
      })
    ).toThrow(/SCVS_BATCH_JOB_QUEUE_ARN_AMD64/);
  });
});

describe("selectJobQueue — a recorded architecture", () => {
  it("wins over a probe that says something else", () => {
    expect(
      selectJobQueue({
        architectures: ["amd64"],
        defaultArch: "amd64",
        queueArns: BOTH,
        jobDefinitions: DEFS,
        recordedArch: "arm64",
      })
    ).toEqual({
      arch: "arm64",
      jobQueueArn: ARM_QUEUE,
      jobDefinition: ARM_DEF,
      reason: "environment_recorded_arch",
    });
  });

  it("wins over the configured default, which is the case that was actually broken", () => {
    expect(
      selectJobQueue({
        architectures: [],
        defaultArch: "amd64",
        queueArns: BOTH,
        jobDefinitions: DEFS,
        recordedArch: "arm64",
      })
    ).toEqual({
      arch: "arm64",
      jobQueueArn: ARM_QUEUE,
      jobDefinition: ARM_DEF,
      reason: "environment_recorded_arch",
    });
  });

  it("reports a reason distinct from every probe outcome", () => {
    const recorded = selectJobQueue({
      architectures: [],
      defaultArch: "arm64",
      queueArns: BOTH,
      jobDefinitions: DEFS,
      recordedArch: "arm64",
    });
    const probed = selectJobQueue({
      architectures: ["arm64"],
      defaultArch: "arm64",
      queueArns: BOTH,
      jobDefinitions: DEFS,
    });
    const guessed = selectJobQueue({
      architectures: [],
      defaultArch: "arm64",
      queueArns: BOTH,
      jobDefinitions: DEFS,
    });

    expect(new Set([recorded.reason, probed.reason, guessed.reason]).size).toBe(3);
    expect(recorded.arch).toBe(probed.arch);
    expect(recorded.arch).toBe(guessed.arch);
  });

  it("still refuses to use the other queue when its own ARN is missing", () => {
    expect(() =>
      selectJobQueue({
        architectures: [],
        defaultArch: "arm64",
        queueArns: { arm64: ARM_QUEUE, amd64: undefined },
        jobDefinitions: DEFS,
        recordedArch: "amd64",
      })
    ).toThrow(/SCVS_BATCH_JOB_QUEUE_ARN_AMD64/);
  });

  it("still refuses to use the other architecture's job definition either", () => {
    expect(() =>
      selectJobQueue({
        architectures: [],
        defaultArch: "arm64",
        queueArns: BOTH,
        jobDefinitions: { arm64: ARM_DEF, amd64: undefined },
        recordedArch: "amd64",
      })
    ).toThrow(/SCVS_BATCH_JOB_DEFINITION_ARN_AMD64/);
  });

  it("changes nothing when absent", () => {
    expect(
      selectJobQueue({
        architectures: ["amd64"],
        defaultArch: "arm64",
        queueArns: BOTH,
        jobDefinitions: DEFS,
      })
    ).toEqual({
      arch: "amd64",
      jobQueueArn: X86_QUEUE,
      jobDefinition: AMD_DEF,
      reason: "image_single_arch",
    });
  });
});
