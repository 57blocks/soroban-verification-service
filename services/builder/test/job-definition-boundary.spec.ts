import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCommand } from "@scvs/core/process";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const CHECKER = join(REPO_ROOT, "eng-tools", "check-taskdef-boundary.mjs");
const BUILDER = join(REPO_ROOT, ".github", "workflows", "deploy-builder.yml");
const SOME_ROLE = "arn:aws:iam::123456789012:role/example-task-role";

type Task = { taskRoleArn?: string; volumes: unknown[]; containers: Record<string, any>[] };

/** The job definition `deploy-builder.yml` registers, with its shell interpolations filled in. */
async function renderedTask(): Promise<Task> {
  const text = await readFile(BUILDER, "utf8");
  const blob = /ECS_PROPERTIES="\{([\s\S]*?)\}"\s*$/m.exec(text)![1]!;
  const json = `{${blob}}`.replace(/\\"/g, '"').replace(/\$\{[^}]*\}/g, "interpolated");
  return (JSON.parse(json) as { taskProperties: Task[] }).taskProperties[0]!;
}

describe("check-taskdef-boundary against the builder's job definition", () => {
  let scratch: string;

  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), "scvs-boundary-"));
    await writeFile(join(scratch, "contract.json"), JSON.stringify({ kind: "batch-job-definition", service: "builder" }));
  });

  afterEach(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  async function check(task: Task): Promise<{ exitCode: number | null; output: string }> {
    const rendered = join(scratch, "jobdef.json");
    await writeFile(rendered, JSON.stringify({ jobDefinitionName: "x", type: "container", ecsProperties: { taskProperties: [task] } }));
    const result = await runCommand(
      ["node", CHECKER, "--env", "dev", "--service", "builder", "--contract", join(scratch, "contract.json"), rendered],
      { mirrorOutput: false, env: { GITHUB_ACTIONS: "" } },
    );
    return { exitCode: result.exit_code, output: `${result.stdout}\n${result.stderr}` };
  }

  it("passes the job definition as the workflow renders it, with no role at all", async () => {
    const task = await renderedTask();
    expect(task.taskRoleArn).toBeUndefined();

    const { exitCode, output } = await check(task);

    expect(output).toContain("no boundary violation");
    expect(exitCode).toBe(0);
  });

  it("refuses a task role", async () => {
    const task = await renderedTask();
    task.taskRoleArn = SOME_ROLE;

    const { exitCode, output } = await check(task);

    expect(exitCode).toBe(1);
    expect(output).toContain("carries taskRoleArn");
  });

  it("refuses a role on a single container", async () => {
    const task = await renderedTask();
    task.containers.find((c) => c.name === "runner")!.jobRoleArn = SOME_ROLE;

    const { exitCode, output } = await check(task);

    expect(exitCode).toBe(1);
    expect(output).toContain("carries jobRoleArn");
  });

  it("refuses the host's docker socket in any container but the gateway", async () => {
    const task = await renderedTask();
    task.containers
      .find((c) => c.name === "runner")!
      .mountPoints.push({ sourceVolume: "docker-sock", containerPath: "/var/run/docker.sock", readOnly: false });

    const { exitCode, output } = await check(task);

    expect(exitCode).toBe(1);
    expect(output).toContain("(runner) mounts the host's docker socket");
  });

  it("refuses a privileged container", async () => {
    const task = await renderedTask();
    task.containers.find((c) => c.name === "materialise")!.privileged = true;

    const { exitCode, output } = await check(task);

    expect(exitCode).toBe(1);
    expect(output).toContain("is privileged");
  });
});
