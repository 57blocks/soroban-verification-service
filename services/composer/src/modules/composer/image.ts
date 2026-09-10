import { isBuildArchitecture, parseCliver } from "@scvs/core";
import type { BuildArchitecture, ComposerSmokeTest, RecordedToolchainPair } from "@scvs/core";
import { runCommand, type CommandResult } from "./process-utils.js";
import type { CompositionTemplate } from "./template.js";

/**
 * Docker-out-of-docker, same arrangement the builder fleet already uses (`XDG_DATA_HOME=/tmp`, a mounted
 * socket).
 */

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

/** The local tag the image carries between build and push. Never pushed, never published. */
function localTag(environmentId: string): string {
  return `scvs-composed:${environmentId}`;
}

/** Whether a tool's `--version` line reports exactly `expected`. */
export function reportsExpectedVersion(reported: string, expected: string): boolean {
  if (expected.length === 0) return false;
  let from = 0;
  for (;;) {
    const at = reported.indexOf(expected, from);
    if (at < 0) return false;
    const before = at === 0 ? "" : reported[at - 1]!;
    const after = reported[at + expected.length] ?? "";
    const boundedLeft = before === "" || !/[0-9.]/.test(before);
    // `-`/`+` are excluded on the right so a prerelease or build-metadata suffix (semver's own separators) is
    // never read as the release it is a candidate for.
    const boundedRight = after === "" || !/[0-9.\-+]/.test(after);
    if (boundedLeft && boundedRight) return true;
    from = at + 1;
  }
}

/**
 * Whether `reported` — the raw output of `stellar version` inside the built image — names the exact stellar-cli
 * commit `rev`.
 */
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
  // The stellar-cli release ships a tar.gz; unpack the single `stellar` binary into the context so the
  // Dockerfile's COPY stays a plain file copy.
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
      // Explicit, never inherited from the build host — see `CompositionTemplate.platform`.
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
      // No cache: a composition is rare (≤ 99 rows ever) and correctness matters more than the minutes a warm
      // cache would save.
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

/**
 * The composer is the only place holding both the declared pair and the freshly-built image, so it is the only
 * place this check can live.
 */
export async function smokeTestComposedImage(input: {
  environmentId: string;
  pair: RecordedToolchainPair;
  timeoutMs: number;
  dockerHost?: string;
}): Promise<ComposerSmokeTest> {
  const reportedRsver = await reportedVersion(input, ["rustc", "--version"], "rustc");
  const reportedCliver = await reportedVersion(input, ["stellar", "version"], "stellar");

  // Token-bounded containment rather than equality or a bare substring — see `reportsExpectedVersion()`.
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
      // The smoke test runs no submitted code and needs no network. Dropped anyway, because a container that
      // does not need the network should not have it.
      "--network=none",
      // The old form worked only because v1 and v2 inherited no entrypoint from `buildpack-deps`.
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
  // Preserve the complete output so the caller can validate both halves of `<version>#<rev>`; one-line
  // formatting belongs only in progress logs.
  return `${result.stdout}`.trim();
}

/**
 * Tags, pushes, and returns the digest ECR assigned — or, if this recipe's tag is already taken on the
 * immutable repository, the digest already stored under it.
 */
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
    // The tag is `recipe_sha256`, so an occupied tag means this exact recipe is already composed and stored;
    // the repository being IMMUTABLE is what turns that into a push failure.
    return adoptStoredImage(remote, input);
  }

  return readRepoDigest(remote, input, "Could not read back the pushed image's digest.");
}

/** The digest ECR holds for an already-stored tag. */
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

/**
 * Reads the digest from the registry's own statement about what it stored, rather than parsing `docker push`
 * progress output.
 */
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

/** Splits `docker inspect --format={{index .RepoDigests 0}}\t{{.Architecture}}` into its two facts. */
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

/**
 * Whether a failed `docker push` failed *only* because the tag is already taken on an immutable repository —
 * ECR's `ImageTagAlreadyExistsException`, which the CLI surfaces as prose.
 */
export function isImmutableTagConflict(push: { stdout: string; stderr: string }): boolean {
  const output = `${push.stdout}\n${push.stderr}`.toLowerCase();
  if (output.includes("imagetagalreadyexists")) return true;
  return output.includes("already exists") && output.includes("immutable");
}

/** `aws ecr get-login-password | docker login`. */
async function authenticateToEcr(input: {
  ecrRepositoryUri: string;
  dockerHost?: string;
}): Promise<void> {
  const registry = input.ecrRepositoryUri.split("/")[0]!;
  const region = registryRegion(registry);

  const password = await runCommand(
    ["aws", "ecr", "get-login-password", "--region", region],
    // Not mirrored to stdout: the value is a registry credential. Everything else in this file mirrors freely,
    // which is exactly why this one has to say no explicitly.
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

/** `<account>.dkr.ecr.<region>.amazonaws.com` → `<region>`. */
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

/** Bounded, and stderr-first — the same shape the builder's diagnostics use. */
function excerpt(result: CommandResult): string {
  const text = (result.stderr || result.stdout || result.error || "").trim();
  return text.length > 2_000 ? `${text.slice(0, 2_000)}...` : text;
}
