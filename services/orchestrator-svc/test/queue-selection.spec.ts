import { isConfigurationError } from "../src/config/configuration-error.js";
import { selectJobQueue } from "../src/modules/verification-pipeline/queue-selection.util.js";

/** Pure, so these cases need no registry, no container and no Nest container. */
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
    // A registry outage must not stall verification — the worst case of guessing is the failure that happens
    // anyway, and `reason` is what makes the guess visible in the dispatch log line.
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
    // The other queue cannot run this image, so falling back would fail inside the sandbox with a pull or exec
    // error that reads like a build failure.
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
    // The pairing, stated as a property rather than as two literals: whichever arch is chosen, both coordinates
    // must come from that arch's column.
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
    // Before this, an unset amd64 family was not even a concept: the one family was used unconditionally, so an
    // amd64 dispatch silently carried arm64's image.
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
    // Same class for the same reason.
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
    // Not arbitrary: one failure names one variable, and naming the queue first matches the order an operator
    // fixes them in (a family with no queue to run on is not actionable on its own).
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

/**
 * A composed environment lives in private ECR, which the architecture probe declines to authenticate against by
 * design.
 */
describe("selectJobQueue — a recorded architecture", () => {
  it("wins over a probe that says something else", () => {
    // Not a realistic disagreement — it is the assertion that precedence is real rather than incidental to the
    // probe usually being empty on this path.
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
    // `image_single_arch` was the tempting reuse and would have been a lie: it means the *registry* said the
    // image publishes one architecture.
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
    // Recorded evidence makes the architecture certain; it does not make the missing variable optional.
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
