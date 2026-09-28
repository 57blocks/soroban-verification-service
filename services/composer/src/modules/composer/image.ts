import { isBuildArchitecture, parseCliver } from "@scvs/core";
import type { BuildArchitecture, ComposerSmokeTest, RecordedToolchainPair } from "@scvs/core";
import { runCommand, type CommandResult } from "@scvs/core/process";
import type { CompositionTemplate } from "./template.js";

export class ImageError extends Error {
  readonly reason: string;
  readonly context: Record<string, unknown>;

  constructor(reason: string, message: string, context: Record<string, unknown> = {}) {
    super(message);
    this.name = "ImageError";
    this.reason = reason;
    this.context = context;
  }
}

function localTag(environmentId: string): string {
  return `scvs-composed:${environmentId}`;
}

export function reportsExpectedVersion(reported: string, expected: string): boolean {
  if (expected.length === 0) return false;
  let from = 0;
  for (;;) {
    const at = reported.indexOf(expected, from);
    if (at < 0) return false;
    const before = at === 0 ? "" : reported[at - 1]!;
    const after = reported[at + expected.length] ?? "";
    const boundedLeft = before === "" || !/[0-9.]/.test(before);
    // `-`/`+` are excluded on the right so a prerelease or build-metadata suffix never reads as its release.
    const boundedRight = after === "" || !/[0-9.\-+]/.test(after);
    if (boundedLeft && boundedRight) return true;
    from = at + 1;
  }
}

export function reportsExpectedRev(reported: string, rev: string): boolean {
  if (rev.length === 0) return false;
  let from = 0;
  for (;;) {
    const at = reported.indexOf(rev, from);
    if (at < 0) return false;
    const before = at === 0 ? "" : reported[at - 1]!;
    const after = reported[at + rev.length] ?? "";
    const boundedLeft = before === "" || !/[0-9A-Za-z]/.test(before);
    const boundedRight = after === "" || !/[0-9A-Za-z]/.test(after);
    if (boundedLeft && boundedRight) return true;
    from = at + 1;
  }
}

export async function buildComposedImage(input: {
  environmentId: string;
  pair: RecordedToolchainPair;
  template: CompositionTemplate;
  templateDir: string;
  contextDir: string;
  timeoutMs: number;
  dockerHost?: string;
}): Promise<void> {
  const extract = await runCommand(
    ["tar", "-xzf", "stellar-cli-archive", "-C", ".", "stellar"],
    { cwd: input.contextDir, timeout_ms: 60_000, env: dockerEnv(input.dockerHost) },
  );
  if (extract.exit_code !== 0) {
    throw new ImageError(
      "cli_archive_extract_failed",
      "Could not extract the `stellar` binary from the verified release archive.",
      { detail: excerpt(extract) },
    );
  }

  const build = await runCommand(
    [
      "docker",
      "build",
      "--platform",
      input.template.platform,
      "--file",
      `${input.templateDir}/Dockerfile`,
      "--build-arg",
      `BASE_IMAGE=${input.template.baseImage.reference}@${input.template.baseImage.digest}`,
      "--build-arg",
      `RSVER=${input.pair.rsver}`,
      "--build-arg",
      `CLIVER=${input.pair.cliver}`,
      "--build-arg",
      `RUST_PROFILE=${input.template.rust.profile}`,
      "--build-arg",
      `RUST_TARGETS=${input.template.rust.targets.join(",")}`,
      "--no-cache",
      "--pull=false",
      "--tag",
      localTag(input.environmentId),
      ".",
    ],
    { cwd: input.contextDir, timeout_ms: input.timeoutMs, env: dockerEnv(input.dockerHost) },
  );
  if (build.exit_code !== 0) {
    throw new ImageError("image_build_failed", "The composed environment did not build.", {
      timed_out: build.timed_out,
      detail: excerpt(build),
    });
  }
}

export async function smokeTestComposedImage(input: {
  environmentId: string;
  pair: RecordedToolchainPair;
  timeoutMs: number;
  dockerHost?: string;
}): Promise<ComposerSmokeTest> {
  const reportedRsver = await reportedVersion(input, ["rustc", "--version"], "rustc");
  const reportedCliver = await reportedVersion(input, ["stellar", "version"], "stellar");

  const recorded = parseCliver(input.pair.cliver);
  const matchesPair =
    recorded !== undefined &&
    reportsExpectedVersion(reportedRsver, input.pair.rsver) &&
    reportsExpectedVersion(reportedCliver, recorded.version) &&
    recorded.rev !== undefined &&
    reportsExpectedRev(reportedCliver, recorded.rev);

  return {
    reported_cliver: reportedCliver,
    reported_rsver: reportedRsver,
    matches_pair: matchesPair,
  };
}

export async function reportedVersion(
  input: { environmentId: string; timeoutMs: number; dockerHost?: string },
  command: string[],
  tool: string,
  runner: typeof runCommand = runCommand,
): Promise<string> {
  const result = await runner(
    [
      "docker",
      "run",
      "--rm",
      "--network=none",
      "--entrypoint",
      command[0]!,
      localTag(input.environmentId),
      ...command.slice(1),
    ],
    { timeout_ms: input.timeoutMs, env: dockerEnv(input.dockerHost) },
  );
  if (result.exit_code !== 0) {
    throw new ImageError(
      "smoke_test_failed",
      `Could not run \`${command.join(" ")}\` inside the composed image.`,
      { tool, detail: excerpt(result) },
    );
  }
  // The complete output: the caller validates both halves of `<version>#<rev>`.
  return `${result.stdout}`.trim();
}

export async function pushComposedImage(input: {
  environmentId: string;
  recipeSha256: string;
  ecrRepositoryUri: string;
  timeoutMs: number;
  dockerHost?: string;
}): Promise<{ digest: string; architecture?: BuildArchitecture }> {
  await authenticateToEcr(input);

  const remote = `${input.ecrRepositoryUri}:${input.recipeSha256}`;
  const tag = await runCommand(["docker", "tag", localTag(input.environmentId), remote], {
    timeout_ms: 60_000,
    env: dockerEnv(input.dockerHost),
  });
  if (tag.exit_code !== 0) {
    throw new ImageError("ecr_push_failed", "Could not tag the composed image for its repository.", {
      detail: excerpt(tag),
    });
  }

  const push = await runCommand(["docker", "push", remote], {
    timeout_ms: input.timeoutMs,
    env: dockerEnv(input.dockerHost),
  });
  if (push.exit_code !== 0) {
    if (!isImmutableTagConflict(push)) {
      throw new ImageError("ecr_push_failed", "Pushing the composed image to ECR failed.", {
        timed_out: push.timed_out,
        detail: excerpt(push),
      });
    }
    // The tag is `recipe_sha256`, so an occupied tag on the immutable repository already holds this exact recipe.
    return adoptStoredImage(remote, input);
  }

  return readRepoDigest(remote, input, "Could not read back the pushed image's digest.");
}

async function adoptStoredImage(
  remote: string,
  input: { timeoutMs: number; dockerHost?: string },
): Promise<{ digest: string; architecture?: BuildArchitecture }> {
  const pull = await runCommand(["docker", "pull", remote], {
    timeout_ms: input.timeoutMs,
    env: dockerEnv(input.dockerHost),
  });
  if (pull.exit_code !== 0) {
    throw new ImageError(
      "ecr_push_failed",
      "This recipe is already stored under its tag, but the stored image could not be read back.",
      { timed_out: pull.timed_out, detail: excerpt(pull) },
    );
  }
  return readRepoDigest(remote, input, "Could not read the stored image's digest.");
}

async function readRepoDigest(
  remote: string,
  input: { dockerHost?: string },
  failureMessage: string,
): Promise<{ digest: string; architecture?: BuildArchitecture }> {
  const inspect = await runCommand(
    ["docker", "inspect", "--format={{index .RepoDigests 0}}\t{{.Architecture}}", remote],
    { timeout_ms: 60_000, env: dockerEnv(input.dockerHost) },
  );
  if (inspect.exit_code !== 0) {
    throw new ImageError("ecr_push_failed", failureMessage, { detail: excerpt(inspect) });
  }

  const parsed = parseInspectedImage(inspect.stdout);
  if (!parsed.digest) {
    throw new ImageError(
      "ecr_push_failed",
      `The registry reported an unusable digest ${JSON.stringify(parsed.repoDigest)}.`,
      { repo_digest: parsed.repoDigest },
    );
  }
  return {
    digest: parsed.digest,
    ...(parsed.architecture ? { architecture: parsed.architecture } : {}),
  };
}

export function parseInspectedImage(stdout: string): {
  repoDigest: string;
  digest?: string;
  architecture?: BuildArchitecture;
} {
  const [repoDigestField, architectureField] = stdout.trim().split("\t");
  const repoDigest = (repoDigestField ?? "").trim();
  const at = repoDigest.lastIndexOf("@");
  const candidate = at === -1 ? "" : repoDigest.slice(at + 1);
  const architecture = (architectureField ?? "").trim();

  return {
    repoDigest,
    ...(/^sha256:[0-9a-f]{64}$/.test(candidate) ? { digest: candidate } : {}),
    ...(isBuildArchitecture(architecture) ? { architecture } : {}),
  };
}

export function isImmutableTagConflict(push: { stdout: string; stderr: string }): boolean {
  const output = `${push.stdout}\n${push.stderr}`.toLowerCase();
  if (output.includes("imagetagalreadyexists")) return true;
  return output.includes("already exists") && output.includes("immutable");
}

async function authenticateToEcr(input: {
  ecrRepositoryUri: string;
  dockerHost?: string;
}): Promise<void> {
  const registry = input.ecrRepositoryUri.split("/")[0]!;
  const region = registryRegion(registry);

  const password = await runCommand(
    ["aws", "ecr", "get-login-password", "--region", region],
    // Not mirrored to stdout: the value is a registry credential.
    { timeout_ms: 60_000, mirrorOutput: false },
  );
  if (password.exit_code !== 0 || !password.stdout.trim()) {
    throw new ImageError("ecr_auth_failed", "Could not obtain an ECR authorization token.", {
      // `stderr` only, and never `stdout`: on success stdout is the token itself.
      detail: password.stderr.slice(0, 500) || password.error,
      region,
    });
  }

  const login = await runCommand(
    ["docker", "login", "--username", "AWS", "--password-stdin", registry],
    {
      timeout_ms: 60_000,
      env: dockerEnv(input.dockerHost),
      stdin: password.stdout.trim(),
      mirrorOutput: false,
    },
  );
  if (login.exit_code !== 0) {
    throw new ImageError("ecr_auth_failed", "`docker login` against ECR failed.", {
      detail: login.stderr.slice(0, 500) || login.error,
      registry,
    });
  }
}

export function registryRegion(registry: string): string {
  const match = /\.dkr\.ecr\.([a-z0-9-]+)\.amazonaws\.com$/.exec(registry);
  if (!match) {
    throw new ImageError(
      "ecr_auth_failed",
      `Cannot derive a region from registry ${JSON.stringify(registry)}; expected ` +
        "<account>.dkr.ecr.<region>.amazonaws.com.",
      { registry },
    );
  }
  return match[1]!;
}

function dockerEnv(dockerHost?: string): NodeJS.ProcessEnv | undefined {
  return dockerHost ? { DOCKER_HOST: dockerHost } : undefined;
}

function excerpt(result: CommandResult): string {
  const text = (result.stderr || result.stdout || result.error || "").trim();
  return text.length > 2_000 ? `${text.slice(0, 2_000)}...` : text;
}
