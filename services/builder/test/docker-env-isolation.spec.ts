import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/modules/builder/run-cli.js";
import { forgetJobParamsEnvironment } from "../src/config/configuration.js";

const IMAGE = `docker.io/stellar/stellar-cli@sha256:${"d".repeat(64)}`;
const WASM = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
const WASM_SHA256 = createHash("sha256").update(WASM).digest("hex");

// Records, for every docker invocation, the environment the CLI itself was started with.
const FAKE_DOCKER = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
fs.appendFileSync(path.join(__dirname, "runs.log"), JSON.stringify({ args, env: process.env }) + "\\n");
if (args[0] === "version") process.exit(0);
const entrypoint = args.includes("--entrypoint") ? args[args.indexOf("--entrypoint") + 1] : undefined;
if (entrypoint === "rustup") { console.log("stable"); process.exit(0); }
if (entrypoint === "cargo") process.exit(0);
const artifact = args.flatMap((arg, i) => (args[i - 1] === "--mount" && arg.includes("target=/artifact,") ? [/source=([^,]+)/.exec(arg)[1]] : []))[0];
if (artifact) {
  fs.writeFileSync(path.join(artifact, "c.wasm"), Buffer.from(${JSON.stringify([...WASM])}));
  console.log("Wasm File: /artifact/c.wasm");
  console.log("Wasm Hash: ${WASM_SHA256}");
}
process.exit(0);
`;

describe("the docker CLI never sees the runner's own environment", () => {
  const saved = { ...process.env };
  let fakeBin: string;
  let sourceRoot: string;
  let workDirs: string[];

  beforeEach(async () => {
    fakeBin = await mkdtemp(join(tmpdir(), "scvs-env-docker-"));
    await writeFile(join(fakeBin, "docker"), FAKE_DOCKER);
    await chmod(join(fakeBin, "docker"), 0o755);
    sourceRoot = join(await mkdtemp(join(tmpdir(), "scvs-env-src-")), "source");
    await mkdir(sourceRoot, { recursive: true });
    await writeFile(join(sourceRoot, "Cargo.toml"), '[package]\nname = "c"\nversion = "0.0.0"\n');
    workDirs = [];
    process.env.PATH = `${fakeBin}:${saved.PATH}`;
    process.env.SCVS_JOB_PARAMS_URL = "https://staging.example/params/runner.json?X-Amz-Signature=secret";
    process.env.RUNNER_ONLY_CANARY = "runner-secret";
  });

  afterEach(async () => {
    process.env = { ...saved };
    for (const dir of [fakeBin, join(sourceRoot, ".."), ...workDirs]) await rm(dir, { recursive: true, force: true });
  });

  async function rebuild(bldopt: string[]) {
    return runCli({
      mode: "build",
      target: { network: "testnet", wasm_hash: "a".repeat(64) },
      build: { image: IMAGE, workspace_path: ".", target: "wasm32v1-none", bldarg: [], bldopt },
      source: { mode: "hosted_tarball", visibility: "public", workspace_path: sourceRoot, retained_after_verification: false },
      config: { cliTimeoutMs: 10_000 },
      workDirs,
    });
  }

  async function runs(): Promise<{ args: string[]; env: Record<string, string> }[]> {
    const log = await readFile(join(fakeBin, "runs.log"), "utf8").catch(() => "");
    return log.split("\n").filter(Boolean).map((line) => JSON.parse(line));
  }

  it("starts every docker command without the runner's variables", async () => {
    const result = await rebuild([]);

    expect(result.outcome).toBe("built");
    const logged = await runs();
    expect(logged.length).toBeGreaterThan(0);
    for (const run of logged) {
      expect(run.env.SCVS_JOB_PARAMS_URL).toBeUndefined();
      expect(run.env.RUNNER_ONLY_CANARY).toBeUndefined();
    }
  });

  it("refuses a bare --env name before any container runs", async () => {
    const result = await rebuild(["--env=RUNNER_ONLY_CANARY"]);

    expect(result.outcome).toBe("cli_failure");
    expect(result.reason).toBe("recorded_env_option_refused");
    expect((await runs()).some((run) => run.args.includes("RUNNER_ONLY_CANARY"))).toBe(false);
  });

  it("forgets the job params once the config has read them", () => {
    process.env.SCVS_JOB_PARAMS_JSON = '{"artifact_upload_url":"https://x"}';

    forgetJobParamsEnvironment();

    expect(process.env.SCVS_JOB_PARAMS_URL).toBeUndefined();
    expect(process.env.SCVS_JOB_PARAMS_JSON).toBeUndefined();
  });
});
