import { EventBridgeClient, PutEventsCommand } from "@aws-sdk/client-eventbridge";

export function createEventBridgeClient(region?: string): EventBridgeClient {
  return new EventBridgeClient({ region: region || "us-east-1" });
}

export type PutEventParams = {
  source: string;
  detailType: string;
  detail: unknown;
  eventBusName?: string;
};

export async function putEvent(client: EventBridgeClient, params: PutEventParams): Promise<void> {
  await client.send(
    new PutEventsCommand({
      Entries: [
        {
          Source: params.source,
          DetailType: params.detailType,
          Detail: JSON.stringify(params.detail),
          ...(params.eventBusName ? { EventBusName: params.eventBusName } : {}),
        },
      ],
    }),
  );
}

export type BatchJobStateChangeEvent = {
  jobId: string;
  status: string;
  statusReason?: string;
};

/**
 * Defensively parses an AWS "Batch Job State Change" EventBridge event's `detail` block (`detail.jobId` /
 * `detail.status` / `detail.statusReason`).
 */
export function parseBatchJobStateChangeEvent(raw: unknown): BatchJobStateChangeEvent | undefined {
  if (!isRecord(raw)) return undefined;
  const detail = raw.detail;
  if (!isRecord(detail)) return undefined;
  const { jobId, status, statusReason } = detail;
  if (typeof jobId !== "string" || typeof status !== "string") return undefined;
  return {
    jobId,
    status,
    ...(typeof statusReason === "string" ? { statusReason } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
