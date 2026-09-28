import type { RegisteredTaskProperties } from "@scvs/aws";

// Batch rejects a SubmitJob whose merged taskProperties (definition's static fields plus override) reach 8192 bytes.

export const TASKPROPERTIES_LIMIT_BYTES = 8192;

/** Slack for serialization differences between our merged JSON and AWS's internal document. */
export const TASKPROPERTIES_SAFETY_MARGIN_BYTES = 128;

export type OverrideContainer = {
  name: string;
  environment?: Array<{ name: string; value: string }>;
};

export type MergedPayloadMeasurement = {
  totalBytes: number;
  overrideBytes: number;
  staticBytes: number;
};

export function measureMergedTaskProperties(
  overrideContainers: OverrideContainer[],
  registered: RegisteredTaskProperties,
): MergedPayloadMeasurement {
  const registeredNames = new Set(
    registered.taskProperties.flatMap((taskProperty) =>
      taskProperty.containers.map((container) => container.name),
    ),
  );
  const mergedContainers = registered.taskProperties.flatMap((taskProperty) =>
    taskProperty.containers.map((container) => {
      const override = overrideContainers.find(
        (candidate) => candidate.name === container.name,
      );
      if (!override) return container;
      const overridden = new Set(override.environment?.map((entry) => entry.name));
      const survivingStatic = (container.environment ?? []).filter(
        (entry) => !overridden.has(entry.name),
      );
      return {
        ...container,
        environment: [...survivingStatic, ...(override.environment ?? [])],
      };
    }),
  );
  const unmatchedOverrides = overrideContainers.filter(
    (container) => !registeredNames.has(container.name),
  );
  const allContainers = [...mergedContainers, ...unmatchedOverrides];
  const serialize = (containers: unknown): number =>
    Buffer.byteLength(JSON.stringify({ taskProperties: [{ containers }] }));
  return {
    totalBytes: serialize(allContainers),
    overrideBytes: serialize(overrideContainers),
    staticBytes: serialize(registered.taskProperties.flatMap((tp) => tp.containers)),
  };
}

export class TaskPropertiesTooLargeError extends Error {
  readonly measurement: MergedPayloadMeasurement;

  constructor(measurement: MergedPayloadMeasurement) {
    super(
      `merged ECS taskProperties payload is ${measurement.totalBytes} bytes, at or over ` +
        `${TASKPROPERTIES_LIMIT_BYTES - TASKPROPERTIES_SAFETY_MARGIN_BYTES} ` +
        `(limit ${TASKPROPERTIES_LIMIT_BYTES} minus ${TASKPROPERTIES_SAFETY_MARGIN_BYTES} margin; ` +
        `static ${measurement.staticBytes}, override ${measurement.overrideBytes}) — ` +
        `SubmitJob would be rejected before any container starts`,
    );
    this.name = "TaskPropertiesTooLargeError";
    this.measurement = measurement;
  }
}

export function assertWithinTaskPropertiesLimit(
  measurement: MergedPayloadMeasurement,
): void {
  if (measurement.totalBytes >= TASKPROPERTIES_LIMIT_BYTES - TASKPROPERTIES_SAFETY_MARGIN_BYTES) {
    throw new TaskPropertiesTooLargeError(measurement);
  }
}
