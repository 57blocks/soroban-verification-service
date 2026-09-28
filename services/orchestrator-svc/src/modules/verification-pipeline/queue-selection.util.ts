import type { BuildArchitecture } from "@scvs/core";
import { ConfigurationError } from "../../config/configuration-error.js";

export type QueueSelectionReason =
  | "environment_recorded_arch"
  | "image_single_arch"
  | "image_multi_arch_default"
  | "image_arch_unresolved_default";

export type QueueSelection = {
  arch: BuildArchitecture;
  jobQueueArn: string;
  jobDefinition: string;
  reason: QueueSelectionReason;
};

const QUEUE_ENV_NAME: Record<BuildArchitecture, string> = {
  arm64: "SCVS_BATCH_JOB_QUEUE_ARN_ARM64",
  amd64: "SCVS_BATCH_JOB_QUEUE_ARN_AMD64",
};

const JOB_DEFINITION_ENV_NAME: Record<BuildArchitecture, string> = {
  arm64: "SCVS_BATCH_JOB_DEFINITION_ARN_ARM64",
  amd64: "SCVS_BATCH_JOB_DEFINITION_ARN_AMD64",
};

export function selectJobQueue(input: {
  architectures: BuildArchitecture[];
  defaultArch: BuildArchitecture;
  queueArns: Record<BuildArchitecture, string | undefined>;
  jobDefinitions: Record<BuildArchitecture, string | undefined>;
  recordedArch?: BuildArchitecture;
}): QueueSelection {
  const { arch, reason } = input.recordedArch
    ? { arch: input.recordedArch, reason: "environment_recorded_arch" as const }
    : chooseArch(input.architectures, input.defaultArch);

  const jobQueueArn = input.queueArns[arch];
  // No fallback to the other architecture's queue: it cannot run this image.
  if (!jobQueueArn) {
    throw new ConfigurationError(
      QUEUE_ENV_NAME[arch],
      `${QUEUE_ENV_NAME[arch]} is required — this rebuild's build image needs the ${arch} Batch job queue ` +
        `(selected because ${reason}), and no ARN is configured for it.`
    );
  }

  const jobDefinition = input.jobDefinitions[arch];
  // Batch accepts a mismatched-architecture job definition, which then fails as "exec format error".
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
    return { arch: distinct[0]!, reason: "image_single_arch" };
  }
  return {
    arch: distinct.includes(defaultArch) ? defaultArch : distinct[0]!,
    reason: "image_multi_arch_default",
  };
}
