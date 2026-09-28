import { authenticateForImage, ecrRegistryRegion } from "../src/modules/builder/sandbox-runtime.js";
import type { CommandResult } from "@scvs/core/process";

const OK: CommandResult = { exit_code: 0, stdout: "", stderr: "", timed_out: false };
const ECR_IMAGE = `123456789012.dkr.ecr.ap-southeast-2.amazonaws.com/scvs-composed-environments@sha256:${"b".repeat(64)}`;
const TOKEN = "AWS-authorization-token-value";

function recordingRunner(replies: Partial<CommandResult>[]) {
  const calls: { command: string[]; stdin?: string; mirrorOutput?: boolean; record?: boolean }[] = [];
  const runner = (async (command: string[], options: { stdin?: string; mirrorOutput?: boolean; record?: boolean } = {}) => {
    calls.push({ command, stdin: options.stdin, mirrorOutput: options.mirrorOutput, record: options.record });
    return { ...OK, ...(replies[calls.length - 1] ?? {}) };
  }) as never;
  return { calls, runner };
}

describe("ecrRegistryRegion", () => {
  it("reads the region out of an ECR registry host", () => {
    expect(ecrRegistryRegion("123456789012.dkr.ecr.ap-southeast-2.amazonaws.com")).toBe("ap-southeast-2");
    expect(ecrRegistryRegion("000000000000.dkr.ecr.us-east-1.amazonaws.com")).toBe("us-east-1");
  });

  it("returns undefined for anything that is not a private ECR registry", () => {
    for (const host of [
      "docker.io",
      "index.docker.io",
      "ghcr.io",
      "public.ecr.aws",
      "123456789012.dkr.ecr.ap-southeast-2.amazonaws.com.evil.test",
      "notanaccount.dkr.ecr.ap-southeast-2.amazonaws.com",
      "",
    ]) {
      expect(ecrRegistryRegion(host)).toBeUndefined();
    }
  });
});

describe("authenticateForImage", () => {
  it("runs nothing at all for a Docker Hub image", async () => {
    for (const image of [
      `docker.io/stellar/stellar-cli@sha256:${"a".repeat(64)}`,
      `stellar/stellar-cli@sha256:${"a".repeat(64)}`,
      "public.ecr.aws/foo/bar:latest",
    ]) {
      const { calls, runner } = recordingRunner([]);
      await expect(authenticateForImage(image, undefined, runner)).resolves.toEqual({
        ok: true,
        skipped: true,
      });
      expect(calls).toEqual([]);
    }
  });

  it("logs in to the image's own registry, in its own region", async () => {
    const { calls, runner } = recordingRunner([{ stdout: `${TOKEN}\n` }, {}]);

    await expect(authenticateForImage(ECR_IMAGE, undefined, runner)).resolves.toEqual({
      ok: true,
      skipped: false,
    });

    expect(calls[0].command).toEqual(["aws", "ecr", "get-login-password", "--region", "ap-southeast-2"]);
    expect(calls[1].command).toEqual([
      "docker",
      "login",
      "--username",
      "AWS",
      "--password-stdin",
      "123456789012.dkr.ecr.ap-southeast-2.amazonaws.com",
    ]);
  });

  it("passes the token by stdin and never in an argv", async () => {
    const { calls, runner } = recordingRunner([{ stdout: `${TOKEN}\n` }, {}]);
    await authenticateForImage(ECR_IMAGE, undefined, runner);

    expect(calls[1].stdin).toBe(TOKEN);
    for (const call of calls) {
      expect(call.command.join(" ")).not.toContain(TOKEN);
    }
  });

  it("never mirrors either command's output", async () => {
    const { calls, runner } = recordingRunner([{ stdout: `${TOKEN}\n` }, {}]);
    await authenticateForImage(ECR_IMAGE, undefined, runner);
    expect(calls.map((call) => call.mirrorOutput)).toEqual([false, false]);
  });

  it("never records the credential-producing command into the build-log sink", async () => {
    const { calls, runner } = recordingRunner([{ stdout: `${TOKEN}\n` }, {}]);
    await authenticateForImage(ECR_IMAGE, undefined, runner);

    expect(calls[0].record).toBe(false);
    expect(calls[1].record).toBeUndefined();
  });

  it("reports a refusal rather than throwing when the token cannot be obtained", async () => {
    const { calls, runner } = recordingRunner([
      { exit_code: 255, stderr: "Unable to locate credentials" },
    ]);

    await expect(authenticateForImage(ECR_IMAGE, undefined, runner)).resolves.toMatchObject({
      ok: false,
      reason: "ecr_auth_failed",
    });
    expect(calls).toHaveLength(1);
  });

  it("treats an empty token as a failure, not as a password", async () => {
    const { calls, runner } = recordingRunner([{ exit_code: 0, stdout: "   \n" }]);
    await expect(authenticateForImage(ECR_IMAGE, undefined, runner)).resolves.toMatchObject({
      ok: false,
      reason: "ecr_auth_failed",
    });
    expect(calls).toHaveLength(1);
  });

  it("reports a login failure without leaking the token into the detail", async () => {
    const { runner } = recordingRunner([
      { stdout: `${TOKEN}\n` },
      { exit_code: 1, stderr: "unauthorized: authentication required" },
    ]);

    const result = await authenticateForImage(ECR_IMAGE, undefined, runner);
    expect(result).toMatchObject({ ok: false, reason: "ecr_auth_failed" });
    if (result.ok === false) {
      expect(result.detail).toContain("123456789012.dkr.ecr.ap-southeast-2.amazonaws.com");
      expect(result.detail).toContain("unauthorized");
      expect(result.detail).not.toContain(TOKEN);
    }
  });
});
