import type { BuildArchitecture } from "@scvs/core";
import { ConfigurationError } from "../../config/configuration-error.js";

/** Which Batch job queue a rebuild goes to — **and which builder job definition runs on it**. */

export type QueueSelectionReason =
  /** The `Environment` row records what our own composer built, so no registry was asked at all. */
  | "environment_recorded_arch"
  /** The image publishes exactly one architecture — it, not configuration, chose the queue. */
  | "image_single_arch"
  /** The image runs on more than one; `SCVS_BATCH_DEFAULT_ARCH` broke the tie. */
  | "image_multi_arch_default"
  /** The registry could not tell us. Falls back to the same default rather than failing the job. */
  | "image_arch_unresolved_default";

export type QueueSelection = {
  arch: BuildArchitecture;
  jobQueueArn: string;
  /** The builder job-definition family for `arch`. */
  jobDefinition: string;
  reason: QueueSelectionReason;
};

/** The variable a missing ARN names, so the failure says what to set rather than what went wrong. */
const QUEUE_ENV_NAME: Record<BuildArchitecture, string> = {
  arm64: "SCVS_BATCH_JOB_QUEUE_ARN_ARM64",
  amd64: "SCVS_BATCH_JOB_QUEUE_ARN_AMD64",
};

/** Same idea for the job definition, and deliberately the SAME NAMING SHAPE as the queue pair above. */
const JOB_DEFINITION_ENV_NAME: Record<BuildArchitecture, string> = {
  arm64: "SCVS_BATCH_JOB_DEFINITION_ARN_ARM64",
  amd64: "SCVS_BATCH_JOB_DEFINITION_ARN_AMD64",
};

export function selectJobQueue(input: {
  /** What the image publishes. Empty means the probe could not establish it. */
  architectures: BuildArchitecture[];
  defaultArch: BuildArchitecture;
  queueArns: Record<BuildArchitecture, string | undefined>;
  /**
   * The builder job-definition family per architecture. Both halves are looked up from the same resolved `arch`
   * as `queueArns`, which is the whole point — see this file's header.
   */
  jobDefinitions: Record<BuildArchitecture, string | undefined>;
  /** What the `Environment` row records for a composed environment, when it records anything. */
  recordedArch?: BuildArchitecture;
}): QueueSelection {
  const { arch, reason } = input.recordedArch
    ? { arch: input.recordedArch, reason: "environment_recorded_arch" as const }
    : chooseArch(input.architectures, input.defaultArch);

  const jobQueueArn = input.queueArns[arch];
  // Deliberately NOT falling back to the other architecture's queue: that queue cannot run this image, so the
  // build would fail inside the sandbox with a pull or exec error that reads like a build failure.
  if (!jobQueueArn) {
    throw new ConfigurationError(
      QUEUE_ENV_NAME[arch],
      `${QUEUE_ENV_NAME[arch]} is required — this rebuild's build image needs the ${arch} Batch job queue ` +
        `(selected because ${reason}), and no ARN is configured for it.`
    );
  }

  const jobDefinition = input.jobDefinitions[arch];
  // An arm64 job definition on an x86 queue is accepted by Batch, scheduled, and then fails as `exec format
  // error` in a container whose logs nobody reads, ~30 minutes before the private-upload TTL turns the whole
  // thing into a misleading `private_upload_unavailable`.
  if (!jobDefinition) {
    throw new ConfigurationError(
      JOB_DEFINITION_ENV_NAME[arch],
      `${JOB_DEFINITION_ENV_NAME[arch]} is required — this rebuild's build image needs an ${arch} builder ` +
        `job definition (selected because ${reason}), and none is configured for it. The builder image is ` +
        `single-architecture, so the ${arch === "arm64" ? "amd64" : "arm64"} family cannot run here.`
    );
  }

  return { arch, jobQueueArn, jobDefinition, reason };
}

function chooseArch(
  architectures: BuildArchitecture[],
  defaultArch: BuildArchitecture
): { arch: BuildArchitecture; reason: QueueSelectionReason } {
  const distinct = [...new Set(architectures)];

  if (distinct.length === 0) {
    return { arch: defaultArch, reason: "image_arch_unresolved_default" };
  }
  if (distinct.length === 1) {
    // The image forces the queue — `defaultArch` is not consulted at all.
    return { arch: distinct[0]!, reason: "image_single_arch" };
  }
  // Runs on several. Prefer the configured default when it is one of them; otherwise take the first published
  // architecture, which keeps the choice deterministic for a set the default is not in.
  return {
    arch: distinct.includes(defaultArch) ? defaultArch : distinct[0]!,
    reason: "image_multi_arch_default",
  };
}
