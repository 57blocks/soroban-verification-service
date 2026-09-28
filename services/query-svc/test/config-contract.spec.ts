import { describe, expect, it } from "@jest/globals";
import {
  CONFIG_CONTRACT_LOG_PREFIX,
  ENV_CONTRACT,
  formatConfigContractLogLine,
  reportConfigContract,
} from "@scvs/config";

const CANARY = "SECRET-CANARY-3f9a1c";

const SECRET_VARS = [
  "POSTGRES_PASSWORD",
  "POSTGRES_USER",
  "DATABASE_URL",
  "SCVS_ARWEAVE_WALLET_PRIVATE_KEY",
] as const;

function envWithEverythingSet(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const descriptors of Object.values(ENV_CONTRACT)) {
    for (const d of descriptors) env[d.name] = CANARY;
  }
  env.NODE_ENV = "production";
  env.POSTGRES_SSL = "true";
  env.SCVS_PUBLISHER_STORAGE = "s3";
  env.SCVS_ARWEAVE_MODE = "disabled";
  env.SCVS_ARWEAVE_NETWORK = "devnet";
  return env;
}

describe("config contract report", () => {
  it("declares a contract for exactly the three resident services", () => {
    expect(Object.keys(ENV_CONTRACT).sort()).toEqual([
      "orchestrator-svc",
      "query-svc",
      "verification-svc",
    ]);
  });

  it("never has a contract for the builder — the sandbox has no configuration to report (ADR-002)", () => {
    expect(ENV_CONTRACT.builder).toBeUndefined();
  });

  it("reports no secret's value, in any service, even with every variable set", () => {
    const env = envWithEverythingSet();

    for (const service of Object.keys(ENV_CONTRACT)) {
      const report = reportConfigContract(service, env);
      const serialized = JSON.stringify(report);

      for (const secret of SECRET_VARS) {
        if (!(secret in report.variables)) continue;
        expect(typeof report.variables[secret]).toBe("boolean");
      }

      expect(serialized).not.toContain(CANARY);
    }
  });

  it("reports an enum's value and a free-text variable's presence only", () => {
    const report = reportConfigContract("query-svc", envWithEverythingSet());

    expect(report.variables.POSTGRES_SSL).toBe("true");
    expect(report.variables.POSTGRES_HOST).toBe(true);
  });

  it("reports an unset variable as false", () => {
    const report = reportConfigContract("query-svc", {});
    expect(report.variables.POSTGRES_HOST).toBe(false);
  });

  describe("the boot log line", () => {
    it("carries a greppable prefix and parses as JSON", () => {
      const line = formatConfigContractLogLine("query-svc", envWithEverythingSet());

      expect(line.startsWith(CONFIG_CONTRACT_LOG_PREFIX)).toBe(true);
      const parsed = JSON.parse(line.slice(CONFIG_CONTRACT_LOG_PREFIX.length));
      expect(parsed.service).toBe("query-svc");
    });

    it("leaks no secret", () => {
      expect(formatConfigContractLogLine("query-svc", envWithEverythingSet())).not.toContain(CANARY);
    });

    it("never throws for an unknown service — a diagnostic must not break a boot", () => {
      const line = formatConfigContractLogLine("not-a-service");
      expect(line.startsWith(CONFIG_CONTRACT_LOG_PREFIX)).toBe(true);
      expect(JSON.parse(line.slice(CONFIG_CONTRACT_LOG_PREFIX.length)).error).toContain(
        "no config contract declared",
      );
    });
  });
});
