import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSandboxContainer } from "../src/modules/builder/sandbox-container.js";

// `run` records the container it "started" in the cidfile and then hangs, ignoring SIGTERM, as a sandbox
// stage can; `rm` records which container it was asked to remove.
const FAKE_DOCKER = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
fs.appendFileSync(path.join(__dirname, "calls.log"), JSON.stringify(args) + "\\n");
if (args[0] === "run") {
  fs.writeFileSync(args[args.indexOf("--cidfile") + 1], "c0ffee" + "\\n");
  if (args.includes("hang")) {
    process.on("SIGTERM", () => {});
    setInterval(() => {}, 1000);
  } else {
    process.exit(0);
  }
}
if (args[0] === "rm") process.exit(0);
`;

describe("a sandbox stage's container never outlives the stage", () => {
  const saved = { ...process.env };
  let fakeBin: string;

  beforeEach(async () => {
    fakeBin = await mkdtemp(join(tmpdir(), "scvs-cid-docker-"));
    await writeFile(join(fakeBin, "docker"), FAKE_DOCKER);
    await chmod(join(fakeBin, "docker"), 0o755);
    process.env.PATH = `${fakeBin}:${saved.PATH}`;
  });

  afterEach(async () => {
    process.env = { ...saved };
    await rm(fakeBin, { recursive: true, force: true });
  });

  async function calls(): Promise<string[][]> {
    const log = await readFile(join(fakeBin, "calls.log"), "utf8").catch(() => "");
    return log.split("\n").filter(Boolean).map((line) => JSON.parse(line));
  }

  it("removes the container when the stage times out", async () => {
    const cidFile = join(fakeBin, "build.cid");

    const result = await runSandboxContainer(["docker", "run", "--rm", "image", "hang"], { cidFile, timeout_ms: 300 });

    expect(result.timed_out).toBe(true);
    expect(result.containerRemoved).toBe(true);
    expect((await calls()).at(-1)).toEqual(["rm", "--force", "c0ffee"]);
    await expect(readFile(cidFile, "utf8")).rejects.toThrow();
  });

  it("asks nothing more of docker when the stage finishes in time", async () => {
    const result = await runSandboxContainer(["docker", "run", "--rm", "image"], { cidFile: join(fakeBin, "b.cid"), timeout_ms: 10_000 });

    expect(result.timed_out).toBe(false);
    expect((await calls()).map((call) => call[0])).toEqual(["run"]);
    expect((await calls())[0].slice(0, 3)).toEqual(["run", "--cidfile", join(fakeBin, "b.cid")]);
  });
});

describe("the sandbox's own files are removed by the sandbox's own uid", () => {
  const saved = { ...process.env };
  let fakeBin: string;

  beforeEach(async () => {
    fakeBin = await mkdtemp(join(tmpdir(), "scvs-cleanup-docker-"));
    await writeFile(join(fakeBin, "docker"), FAKE_DOCKER);
    await chmod(join(fakeBin, "docker"), 0o755);
    process.env.PATH = `${fakeBin}:${saved.PATH}`;
  });

  afterEach(async () => {
    process.env = { ...saved };
    await rm(fakeBin, { recursive: true, force: true });
  });

  it("empties each directory in a network-less container running as the sandbox user", async () => {
    const { removeSandboxWrites } = await import("../src/modules/builder/sandbox-container.js");

    const left = await removeSandboxWrites({ image: "img@sha256:x", user: "65532:65532", dirs: ["/job/out", "/job/vendor"] });

    expect(left).toEqual([]);
    const log = (await readFile(join(fakeBin, "calls.log"), "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l));
    expect(log).toEqual([
      ["run", "--rm", "--network", "none", "--user", "65532:65532", "--entrypoint", "find", "-v", "/job/out:/w", "img@sha256:x", "/w", "-mindepth", "1", "-delete"],
      ["run", "--rm", "--network", "none", "--user", "65532:65532", "--entrypoint", "find", "-v", "/job/vendor:/w", "img@sha256:x", "/w", "-mindepth", "1", "-delete"],
    ]);
  });

  it("does nothing when no sandbox ran", async () => {
    const { removeSandboxWrites } = await import("../src/modules/builder/sandbox-container.js");

    expect(await removeSandboxWrites({ dirs: [] })).toEqual([]);
  });
});
