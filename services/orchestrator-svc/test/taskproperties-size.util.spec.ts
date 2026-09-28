import type { RegisteredTaskProperties } from "@scvs/aws";
import {
  assertWithinTaskPropertiesLimit,
  measureMergedTaskProperties,
  TASKPROPERTIES_LIMIT_BYTES,
  TaskPropertiesTooLargeError,
} from "../src/modules/verification-pipeline/taskproperties-size.util.js";

const registered: RegisteredTaskProperties = {
  revision: 1,
  taskProperties: [
    {
      containers: [
        {
          name: "materialise",
          image: "registry/builder@sha256:aaaa",
          command: ["node", "materialise-entrypoint.js"],
          essential: false,
          environment: [
            { name: "XDG_DATA_HOME", value: "/tmp" },
            { name: "SCVS_HANDOFF_ROOT", value: "/tmp" },
          ],
        },
        {
          name: "runner",
          image: "registry/builder@sha256:aaaa",
          command: ["node", "entrypoint.js"],
          essential: true,
          dependsOn: [{ containerName: "materialise", condition: "SUCCESS" }],
          environment: [{ name: "XDG_DATA_HOME", value: "/tmp" }],
        },
      ],
    },
  ],
};

describe("measureMergedTaskProperties", () => {
  it("replaces same-name static environment entries with the override's, rather than appending", () => {
    const displacing = measureMergedTaskProperties(
      [{ name: "runner", environment: [{ name: "XDG_DATA_HOME", value: "xxxxxxxxxxxx" }] }],
      registered,
    );
    const appending = measureMergedTaskProperties(
      [{ name: "runner", environment: [{ name: "A_NEW_VARIABLE", value: "xxxxxxxxxxxx" }] }],
      registered,
    );
    expect(appending.totalBytes - displacing.totalBytes).toBeGreaterThan(20);
  });

  it("counts untouched registered containers — they are in the validated document too", () => {
    const withOverride = measureMergedTaskProperties(
      [{ name: "runner", environment: [{ name: "SCVS_JOB_PARAMS_JSON", value: "x" }] }],
      registered,
    );
    const withoutOverride = measureMergedTaskProperties([], registered);
    expect(withOverride.totalBytes).toBeGreaterThan(withoutOverride.totalBytes);
    expect(withOverride.staticBytes).toBe(withoutOverride.staticBytes);
  });

  it("counts an override container the definition does not have", () => {
    const measurement = measureMergedTaskProperties(
      [{ name: "phantom", environment: [{ name: "SCVS_JOB_PARAMS_JSON", value: "y".repeat(4000) }] }],
      registered,
    );
    expect(measurement.totalBytes).toBeGreaterThan(4000);
  });
});

describe("assertWithinTaskPropertiesLimit", () => {
  it("throws a typed error whose message carries sizes only, never values", () => {
    const big = measureMergedTaskProperties(
      [
        {
          name: "runner",
          environment: [{ name: "SCVS_JOB_PARAMS_JSON", value: "SECRETVALUE".repeat(700) }],
        },
      ],
      registered,
    );
    expect(big.totalBytes).toBeGreaterThanOrEqual(TASKPROPERTIES_LIMIT_BYTES - 128);
    try {
      assertWithinTaskPropertiesLimit(big);
      throw new Error("expected the guard to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(TaskPropertiesTooLargeError);
      const message = (error as Error).message;
      expect(message).toMatch(/8192/);
      expect(message).toContain("static ");
      expect(message).toContain("override ");
      expect(message).not.toContain("SECRETVALUE");
    }
  });

  it("passes a payload under the limit minus margin", () => {
    const small = measureMergedTaskProperties(
      [{ name: "runner", environment: [{ name: "SCVS_JOB_PARAMS_URL", value: "https://example.test/blob" }] }],
      registered,
    );
    expect(() => assertWithinTaskPropertiesLimit(small)).not.toThrow();
  });
});
