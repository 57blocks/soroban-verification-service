import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeBuildFlagSupport } from "../src/modules/builder/argument-policy.js";
import { dockerCliOptions } from "../src/modules/builder/docker-env.js";
import { removeSandboxWrites } from "../src/modules/builder/sandbox-container.js";
import { createSandboxWorkspace } from "../src/modules/builder/sandbox-workspace.js";
import type { SandboxWrites } from "../src/modules/builder/run-cli.types.js";
import { probeActiveToolchain } from "../src/modules/builder/toolchain.js";
import { DockerGateway } from "../src/modules/docker-gateway/gateway.js";
import { WorkspaceStore, emptyInProcess } from "../src/modules/docker-gateway/workspaces.js";

const IMAGE = `docker.io/stellar/stellar-cli@sha256:${"a".repeat(64)}`;
const PREFETCH = { network: "scvs-prefetch-0a1b2c3d4e5f", proxy: "http://scvs-egress-proxy:3128" };

describe("the runner through the docker gateway", () => {
  const saved = { ...process.env };
  let dir: string;
  let gateway: DockerGateway;
  let socket: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "scvs-rg-"));
    socket = join(dir, "g.sock");
    gateway = new DockerGateway({
      upstreamSocket: join(dir, "no-daemon.sock"),
      workspaces: new WorkspaceStore({ parent: dir, empty: emptyInProcess }),
      sandboxUser: "65532:65532",
      log: () => undefined,
      prefetch: PREFETCH,
    });
    await gateway.listen(socket);
    process.env.SCVS_DOCKER_GATEWAY = socket;
  });

  afterEach(async () => {
    process.env = { ...saved };
    await gateway.shutdown();
    await rm(dir, { recursive: true, force: true });
  });

  it("points the docker CLI at the gateway and at nothing else", () => {
    process.env.DOCKER_HOST = "unix:///var/run/docker.sock";
    process.env.DOCKER_CONTEXT = "host";
    process.env.DOCKER_TLS_VERIFY = "1";

    const { env } = dockerCliOptions();

    expect(env.DOCKER_HOST).toBe(`unix://${socket}`);
    expect(env.DOCKER_CONTEXT).toBeUndefined();
    expect(env.DOCKER_TLS_VERIFY).toBeUndefined();
  });

  it("takes its workspace from the gateway and hands it back at the end", async () => {
    const workDirs: string[] = [];
    const writes: SandboxWrites = { dirs: [], workspaces: [] };

    const workspace = await createSandboxWorkspace({ workDirs, sandboxWrites: writes });

    expect(workspace.root.startsWith(`${dir}/scvs-sandbox-`)).toBe(true);
    expect(workspace.prefetch).toEqual(PREFETCH);
    expect(workDirs).toEqual([]);
    expect(writes.dirs).toEqual([]);
    expect(writes.workspaces).toHaveLength(1);

    await writeFile(join(workspace.leaves.out, "left-behind"), "x");
    expect(await removeSandboxWrites(writes)).toEqual([]);
    await expect(stat(workspace.root)).rejects.toThrow();
  });

  it("will not build behind a gateway that offers no prefetch network", async () => {
    const bare = new DockerGateway({
      upstreamSocket: join(dir, "no-daemon.sock"),
      workspaces: new WorkspaceStore({ parent: dir, empty: emptyInProcess }),
      sandboxUser: "65532:65532",
      log: () => undefined,
    });
    process.env.SCVS_DOCKER_GATEWAY = join(dir, "bare.sock");
    await bare.listen(process.env.SCVS_DOCKER_GATEWAY);
    try {
      await expect(createSandboxWorkspace({ workDirs: [], sandboxWrites: { dirs: [], workspaces: [] } })).rejects.toThrow(
        "offers no prefetch network",
      );
    } finally {
      await bare.shutdown();
    }
  });

  it("reports a workspace the gateway could not delete", async () => {
    expect(await removeSandboxWrites({ dirs: [], workspaces: ["Unknown1"] })).toEqual(["Unknown1"]);
  });
});

describe("the image probes run in the sandbox's shape", () => {
  const saved = { ...process.env };
  let fakeBin: string;

  beforeEach(async () => {
    fakeBin = await mkdtemp(join(tmpdir(), "scvs-probe-docker-"));
    await writeFile(
      join(fakeBin, "docker"),
      `#!/usr/bin/env node
require("node:fs").appendFileSync(${JSON.stringify(join(fakeBin, "argv.log"))}, JSON.stringify(process.argv.slice(2)) + "\\n");
console.log("stable-x86_64-unknown-linux-gnu --locked");
`,
    );
    await chmod(join(fakeBin, "docker"), 0o755);
    process.env.PATH = `${fakeBin}:${saved.PATH}`;
  });

  afterEach(async () => {
    process.env = { ...saved };
    await rm(fakeBin, { recursive: true, force: true });
  });

  it("gives both probes no network, no capability, a read-only root and the sandbox's uid", async () => {
    await probeActiveToolchain(IMAGE);
    await probeBuildFlagSupport(IMAGE, ["contract", "build", "--help"], "--locked");

    const runs = (await readFile(join(fakeBin, "argv.log"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as string[]);
    expect(runs).toHaveLength(2);
    for (const argv of runs) {
      const image = argv.indexOf(IMAGE);
      const options = argv.slice(0, image);
      expect(options).toEqual(expect.arrayContaining(["--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--read-only"]));
      expect(options[options.indexOf("--network") + 1]).toBe("none");
      expect(options[options.indexOf("--user") + 1]).toBe("65532:65532");
      expect(options).toEqual(expect.arrayContaining(["--memory", "--pids-limit", "--cpus"]));
      expect(options.some((arg) => arg === "--mount" || arg === "-v")).toBe(false);
    }
  });
});
