import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCommand } from "@scvs/core/process";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const CHECKER = join(REPO_ROOT, "eng-tools", "check-mount-paths.mjs");
const BUILDER = join(REPO_ROOT, ".github", "workflows", "deploy-builder.yml");
const COMPOSER = join(REPO_ROOT, ".github", "workflows", "deploy-composer.yml");

const quoted = (value: string) => `\\"${value}\\"`;
const tmpdirEntry = (value: string) => `{${quoted("name")}: ${quoted("TMPDIR")}, ${quoted("value")}: ${quoted(value)}}`;

describe("check-mount-paths against the deployed job definitions", () => {
  let scratch: string;

  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), "scvs-mount-paths-"));
  });

  afterEach(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  async function check(edit: { builder?: (text: string) => string; composer?: (text: string) => string } = {}) {
    const builder = join(scratch, "deploy-builder.yml");
    const composer = join(scratch, "deploy-composer.yml");
    const originals = { builder: await readFile(BUILDER, "utf8"), composer: await readFile(COMPOSER, "utf8") };
    const builderText = (edit.builder ?? ((text) => text))(originals.builder);
    const composerText = (edit.composer ?? ((text) => text))(originals.composer);
    if (edit.builder) expect(builderText).not.toBe(originals.builder);
    if (edit.composer) expect(composerText).not.toBe(originals.composer);
    await writeFile(builder, builderText);
    await writeFile(composer, composerText);
    const result = await runCommand(["node", CHECKER, "--builder", builder, "--composer", composer], {
      mirrorOutput: false,
      env: { GITHUB_ACTIONS: "" },
    });
    return { exitCode: result.exit_code, output: result.stdout };
  }

  it("passes the job definitions as they are", async () => {
    const { exitCode, output } = await check();

    expect(output).toContain("CE3 holds");
    expect(exitCode).toBe(0);
  });

  it("refuses a shared mount on the host's tmpfs /tmp", async () => {
    const { exitCode, output } = await check({
      builder: (text) => text.replaceAll(quoted("/var/tmp"), quoted("/tmp")),
    });

    expect(exitCode).toBe(1);
    expect(output).toContain('builder/runner: volume "scvs-shared" binds host path /tmp, and /tmp is a tmpfs');
    expect(output).toContain('builder/materialise: volume "scvs-shared" binds host path /tmp');
  });

  it("refuses a host path that differs from the container path", async () => {
    const { exitCode, output } = await check({
      composer: (text) =>
        text.replace(
          `${quoted("containerPath")}: ${quoted("/var/tmp")}`,
          `${quoted("containerPath")}: ${quoted("/scratch")}`,
        ),
    });

    expect(exitCode).toBe(1);
    expect(output).toContain("these must be IDENTICAL");
  });

  it("refuses a runner whose temp dir falls back to the image's own /tmp", async () => {
    const { exitCode, output } = await check({
      builder: (text) => text.replace(`,\n                          ${tmpdirEntry("/var/tmp")}`, ""),
    });

    expect(exitCode).toBe(1);
    expect(output).toContain("builder/runner: TMPDIR=/tmp (unset, so the default) is not inside");
  });

  it("refuses a composer whose TMPDIR sits outside its shared mount", async () => {
    const { exitCode, output } = await check({
      composer: (text) => text.replace(tmpdirEntry("/var/tmp"), tmpdirEntry("/opt/scratch")),
    });

    expect(exitCode).toBe(1);
    expect(output).toContain("composer/container: TMPDIR=/opt/scratch is not inside");
  });

  it("refuses a runner that holds the host's docker socket itself", async () => {
    const socketMount = `{${quoted("sourceVolume")}: ${quoted("docker-sock")}, ${quoted("containerPath")}: ${quoted("/var/run/docker.sock")}, ${quoted("readOnly")}: false},`;
    const gatewayMount = `{${quoted("sourceVolume")}: ${quoted("docker-gateway")}, ${quoted("containerPath")}: ${quoted("/run/scvs-docker-gateway")}, ${quoted("readOnly")}: false},`;
    const { exitCode, output } = await check({
      builder: (text) => text.replace(gatewayMount, `${socketMount}\n                          ${gatewayMount}`),
    });

    expect(exitCode).toBe(1);
    expect(output).toContain("builder/runner: mounts the host's docker socket, which only the docker-gateway container may hold");
  });

  it("refuses a runner that is not pointed at the gateway", async () => {
    const { exitCode, output } = await check({
      builder: (text) => text.replace(`${quoted("SCVS_DOCKER_GATEWAY")}, ${quoted("value")}`, `${quoted("SCVS_UNUSED")}, ${quoted("value")}`),
    });

    expect(exitCode).toBe(1);
    expect(output).toContain("builder/runner: SCVS_DOCKER_GATEWAY is not set to a socket in /run/scvs-docker-gateway");
  });

  it("refuses a handoff root outside the shared mount", async () => {
    const { exitCode, output } = await check({
      builder: (text) =>
        text.replace(
          `${quoted("SCVS_HANDOFF_ROOT")}, ${quoted("value")}: ${quoted("/var/tmp")}}\n`,
          `${quoted("SCVS_HANDOFF_ROOT")}, ${quoted("value")}: ${quoted("/srv/handoff")}}\n`,
        ),
    });

    expect(exitCode).toBe(1);
    expect(output).toContain("builder/materialise: SCVS_HANDOFF_ROOT=/srv/handoff is not inside");
  });
});
