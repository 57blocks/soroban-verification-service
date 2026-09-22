import { authenticateForImage, ecrRegistryRegion } from "../src/modules/builder/sandbox-runtime.js";
import type { CommandResult } from "@scvs/core/process";

/** Authenticating to ECR before pulling a composed environment — and *not* authenticating for anything else. */

const OK: CommandResult = { exit_code: 0, stdout: "", stderr: "", timed_out: false };
const ECR_IMAGE = `123456789012.dkr.ecr.ap-southeast-2.amazonaws.com/scvs-composed-environments@sha256:${"b".repeat(64)}`;
const TOKEN = "AWS-authorization-token-value";

/** Records every invocation so the assertions can inspect argv and stdin, not just the return value. */
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
    // Each of these must stay a no-op below.
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
    // cli-58's path, and the assertion is on `calls` rather than the result: "returned ok" would also hold if
    // it had authenticated successfully, which is not what must happen here.
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
    // The rest of this module mirrors to CloudWatch on purpose — its output is build logs.
    const { calls, runner } = recordingRunner([{ stdout: `${TOKEN}\n` }, {}]);
    await authenticateForImage(ECR_IMAGE, undefined, runner);
    expect(calls.map((call) => call.mirrorOutput)).toEqual([false, false]);
  });

  it("never records the credential-producing command into the build-log sink", async () => {
    // `mirrorOutput: false` governs this process's own stdout; the published log is assembled from the sink in
    // `@scvs/core/process`.
    const { calls, runner } = recordingRunner([{ stdout: `${TOKEN}\n` }, {}]);
    await authenticateForImage(ECR_IMAGE, undefined, runner);

    expect(calls[0].record).toBe(false);
    expect(calls[1].record).toBeUndefined();
  });

  it("reports a refusal rather than throwing when the token cannot be obtained", async () => {
    // A throw would surface as an unattributable worker crash; a named reason becomes a diagnosable
    // `cli_failure` carrying the registry that could not be authorised.
    const { calls, runner } = recordingRunner([
      { exit_code: 255, stderr: "Unable to locate credentials" },
    ]);

    await expect(authenticateForImage(ECR_IMAGE, undefined, runner)).resolves.toMatchObject({
      ok: false,
      reason: "ecr_auth_failed",
    });
    // And it stops there: no `docker login` attempted with an empty password.
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
      // Built from stderr only, precisely so a diagnostic can never carry the credential.
      expect(result.detail).not.toContain(TOKEN);
    }
  });
});
