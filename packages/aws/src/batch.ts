import {
  BatchClient,
  DescribeJobDefinitionsCommand,
  DescribeJobsCommand,
  SubmitJobCommand,
} from "@aws-sdk/client-batch";
import type { BatchJobParams } from "@scvs/core";

export function createBatchClient(region?: string): BatchClient {
  return new BatchClient({ region: region || "us-east-1" });
}

export type SubmitJobParams = {
  jobName: string;
  jobQueueArn: string;
  jobDefinitionArn: string;
  parameters?: Record<string, string>;
  containerOverrides?: {
    environment?: Array<{ name: string; value: string }>;
  };
  ecsPropertiesOverride?: {
    taskProperties: Array<{
      containers: Array<{
        name: string;
        environment?: Array<{ name: string; value: string }>;
      }>;
    }>;
  };
};

export async function submitJob(client: BatchClient, params: SubmitJobParams): Promise<{ jobId: string }> {
  const response = await client.send(
    new SubmitJobCommand({
      jobName: params.jobName,
      jobQueue: params.jobQueueArn,
      jobDefinition: params.jobDefinitionArn,
      ...(params.parameters ? { parameters: params.parameters } : {}),
      ...(params.containerOverrides ? { containerOverrides: params.containerOverrides } : {}),
      ...(params.ecsPropertiesOverride
        ? { ecsPropertiesOverride: params.ecsPropertiesOverride }
        : {}),
    }),
  );
  if (!response.jobId) {
    throw new Error("Batch SubmitJob response did not include a jobId.");
  }
  return { jobId: response.jobId };
}

export async function describeJob(
  client: BatchClient,
  jobId: string,
): Promise<{ jobId: string; status: string; statusReason?: string } | undefined> {
  const response = await client.send(new DescribeJobsCommand({ jobs: [jobId] }));
  const job = response.jobs?.[0];
  if (!job || !job.jobId || !job.status) return undefined;
  return {
    jobId: job.jobId,
    status: job.status,
    ...(job.statusReason ? { statusReason: job.statusReason } : {}),
  };
}

export async function describeActiveJobDefinition(
  client: BatchClient,
  familyOrArn: string,
): Promise<RegisteredTaskProperties | undefined> {
  const response = await client.send(
    new DescribeJobDefinitionsCommand({
      jobDefinitions: [familyOrArn],
      status: "ACTIVE",
    }),
  );
  const definition = response.jobDefinitions?.[0];
  const taskProperties = definition?.ecsProperties?.taskProperties;
  if (!definition?.revision || !taskProperties?.length) return undefined;
  return {
    revision: definition.revision,
    taskProperties: taskProperties.map((taskProperty) => ({
      containers: (taskProperty.containers ?? []).map((container) => ({
        ...(container.name !== undefined ? { name: container.name } : {}),
        ...(container.image !== undefined ? { image: container.image } : {}),
        ...(container.command !== undefined ? { command: [...container.command] } : {}),
        ...(container.essential !== undefined ? { essential: container.essential } : {}),
        ...(container.environment
          ? {
              environment: container.environment
                .filter(
                  (entry): entry is { name: string; value: string } =>
                    entry.name !== undefined && entry.value !== undefined,
                )
                .map(({ name, value }) => ({ name, value })),
            }
          : {}),
        ...(container.mountPoints
          ? { mountPoints: container.mountPoints.map((point) => ({ ...point })) }
          : {}),
        ...(container.resourceRequirements
          ? {
              resourceRequirements: container.resourceRequirements.map((requirement) => ({
                ...requirement,
              })),
            }
          : {}),
        ...(container.dependsOn
          ? { dependsOn: container.dependsOn.map((dependency) => ({ ...dependency })) }
          : {}),
      })),
      ...(taskProperty.volumes ? { volumes: taskProperty.volumes.map((volume) => ({ ...volume })) } : {}),
    })),
  };
}

export type RegisteredTaskProperties = {
  revision: number;
  taskProperties: Array<{
    containers: Array<{
      name?: string;
      image?: string;
      command?: string[];
      essential?: boolean;
      environment?: Array<{ name: string; value: string }>;
      mountPoints?: Array<Record<string, unknown>>;
      resourceRequirements?: Array<Record<string, unknown>>;
      dependsOn?: Array<Record<string, unknown>>;
    }>;
    volumes?: Array<Record<string, unknown>>;
  }>;
};
