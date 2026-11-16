import { runCli } from "../src/modules/builder/run-cli.js";

const IMAGE = `docker.io/stellar/stellar-cli@sha256:${"d".repeat(64)}`;

describe("a recipe that sets one setting twice is refused before anything runs", () => {
  it.each([
    [["--package=alpha", "--package=beta"]],
    [["--env=A=1", "--env=A=2"]],
  ])("refuses %j", async (bldopt) => {
    const workDirs: string[] = [];

    const result = await runCli({
      mode: "build",
      target: { network: "testnet", wasm_hash: "a".repeat(64) },
      build: { image: IMAGE, workspace_path: ".", target: "wasm32v1-none", bldarg: [], bldopt },
      source: { mode: "hosted_tarball", visibility: "public", workspace_path: "/nonexistent", retained_after_verification: false },
      config: { cliTimeoutMs: 1_000 },
      workDirs,
    });

    expect(result.outcome).toBe("cli_failure");
    expect(result.reason).toBe("recorded_build_option_repeated");
    expect(workDirs).toEqual([]);
  });
});
