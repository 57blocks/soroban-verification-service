import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { byteSize, recordedCommands, resetRecordedCommands, runCommand, sha256File } from "./process.js";

const node = process.execPath;

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  resetRecordedCommands();
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

await test("captures stdout, stderr and the exit code", async () => {
  const result = await runCommand(
    [node, "-e", "process.stdout.write('out'); process.stderr.write('err'); process.exit(3);"],
    { mirrorOutput: false, record: false },
  );
  assert.equal(result.stdout, "out");
  assert.equal(result.stderr, "err");
  assert.equal(result.exit_code, 3);
  assert.equal(result.timed_out, false);
});

await test("mirrorOutput: false keeps the child's output out of this process's own", async () => {
  const written: string[] = [];
  const realWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    written.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    await runCommand([node, "-e", "process.stdout.write('quiet')"], { mirrorOutput: false, record: false });
  } finally {
    process.stdout.write = realWrite;
  }
  assert.equal(written.join("").includes("quiet"), false);
});

await test("records by default, and record: false leaves no trace", async () => {
  await runCommand([node, "-e", "0"], { mirrorOutput: false });
  assert.equal(recordedCommands().length, 1);
  await runCommand([node, "-e", "0"], { mirrorOutput: false, record: false });
  assert.equal(recordedCommands().length, 1, "an opted-out command must not be retained");
});

await test("a child that never reads stdin does not take the process down", async () => {
  const result = await runCommand([node, "-e", "process.exit(0)"], {
    stdin: "x".repeat(1024 * 256),
    mirrorOutput: false,
    record: false,
  });
  assert.equal(result.exit_code, 0);
});

await test("stdin reaches a child that does read it", async () => {
  const result = await runCommand(
    [node, "-e", "let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>process.stdout.write(d.toUpperCase()));"],
    { stdin: "hello", mirrorOutput: false, record: false },
  );
  assert.equal(result.stdout, "HELLO");
});

await test("a command past its deadline is killed and reported as timed out", async () => {
  const result = await runCommand([node, "-e", "setTimeout(() => {}, 30_000)"], {
    timeout_ms: 150,
    mirrorOutput: false,
    record: false,
  });
  assert.equal(result.timed_out, true);
});

await test("a command that cannot be spawned reports the error rather than throwing", async () => {
  const result = await runCommand(["a-binary-no-machine-has"], { mirrorOutput: false, record: false });
  assert.ok(result.error, "the spawn failure belongs on the result");
  assert.equal(result.timed_out, false);
});

await test("sha256File and byteSize read what is on disk", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scvs-process-test-"));
  try {
    const path = join(dir, "bytes");
    await writeFile(path, "abc");
    assert.equal(await sha256File(path), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    assert.equal(await byteSize(path), 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

resetRecordedCommands();
