import { validateSync } from "class-validator";
import { plainToInstance } from "class-transformer";
import { QuerySvcEnvDto } from "../src/config/env.dto.js";

const QUOTA_VARS = ["SCVS_QUERY_THROTTLE_LIMIT", "SCVS_QUERY_ADDRESS_THROTTLE_LIMIT"] as const;

function errorsFor(variable: string, value: string): string[] {
  const dto = plainToInstance(QuerySvcEnvDto, { [variable]: value });
  return validateSync(dto, { skipMissingProperties: true }).flatMap((error) =>
    Object.values(error.constraints ?? {}),
  );
}

describe.each(QUOTA_VARS)("%s", (variable) => {
  it.each(["0", "-5", "1.5", "+7", "", " ", "abc"])("refuses %p at boot", (value) => {
    expect(errorsFor(variable, value).length).toBeGreaterThan(0);
  });

  it.each(["1", "60", "600", "6000"])("accepts %p", (value) => {
    expect(errorsFor(variable, value)).toEqual([]);
  });
});

describe("the two tiers' ordering", () => {
  const load = async (env: Record<string, string | undefined>) => {
    const previous = { ...process.env };
    Object.assign(process.env, env);
    try {
      const { default: configuration } = await import("../src/config/configuration.js");
      return configuration();
    } finally {
      process.env = previous;
    }
  };

  it("accepts an address tier below the global one", async () => {
    const config = await load({
      SCVS_QUERY_THROTTLE_LIMIT: "600",
      SCVS_QUERY_ADDRESS_THROTTLE_LIMIT: "60",
    });
    expect(config.queryThrottleLimit).toBe(600);
    expect(config.addressThrottleLimit).toBe(60);
  });

  it("refuses an address tier equal to the global one", async () => {
    await expect(
      load({ SCVS_QUERY_THROTTLE_LIMIT: "600", SCVS_QUERY_ADDRESS_THROTTLE_LIMIT: "600" }),
    ).rejects.toThrow(/must be below SCVS_QUERY_THROTTLE_LIMIT/);
  });

  it("refuses an address tier above the global one", async () => {
    await expect(
      load({ SCVS_QUERY_THROTTLE_LIMIT: "60", SCVS_QUERY_ADDRESS_THROTTLE_LIMIT: "600" }),
    ).rejects.toThrow(/must be below SCVS_QUERY_THROTTLE_LIMIT/);
  });

  it("checks the defaults too, not only values someone set", async () => {
    await expect(
      load({ SCVS_QUERY_THROTTLE_LIMIT: "10", SCVS_QUERY_ADDRESS_THROTTLE_LIMIT: undefined }),
    ).rejects.toThrow(/must be below SCVS_QUERY_THROTTLE_LIMIT/);
  });
});
