import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jest } from "@jest/globals";
import type { ConfigService } from "@nestjs/config";
import { parseDto, SandboxDiagnostics } from "@scvs/core";
import {
  describeWasmMismatch,
  inferMismatchCauses,
} from "../src/modules/publish/wasm-compare.util.js";
import type { AppConfigService } from "../src/config/configuration.js";

/** Why a mismatch happened. */

const getObjectBytesBounded = jest.fn<(...args: unknown[]) => Promise<unknown>>();

jest.unstable_mockModule("@scvs/aws", () => ({
  createS3Client: () => ({}),
  getObjectBytesBounded,
  getObjectText: async () => undefined,
  createBatchClient: () => ({}),
  describeJob: async () => undefined,
  presignPutUrl: async () => "https://example.invalid/put",
  submitJob: async () => "batch-job-1",
}));

const { MismatchDiagnosticsService } = await import(
  "../src/modules/verification-pipeline/mismatch-diagnostics.service.js"
);

const MAX_BYTES = 16 * 1024 * 1024;

/** Two real, minimal Wasm binaries — a header plus one custom section — differing only in that section's name. */
function wasmWithCustomSection(name: string): Uint8Array {
  const nameBytes = Buffer.from(name, "utf8");
  const payload = Buffer.concat([Buffer.from([nameBytes.length]), nameBytes]);
  return Uint8Array.from([
    0x00, 0x61, 0x73, 0x6d, // magic
    0x01, 0x00, 0x00, 0x00, // version 1
    0x00, payload.length, // custom section id + size
    ...payload,
  ]);
}

const DEPLOYED = wasmWithCustomSection("contractmetav0");
const REBUILT = wasmWithCustomSection("contractspecv0");

function service() {
  const configService = {
    get: (key: string) =>
      key === "stagingStorage"
        ? { bucket: "scvs-staging", region: "ap-southeast-2" }
        : key === "maxRebuiltWasmBytes"
          ? MAX_BYTES
          : undefined,
  } as unknown as AppConfigService & ConfigService;
  return new MismatchDiagnosticsService(configService);
}

const EXISTING: SandboxDiagnostics = {
  runner: "docker_build_image_rebuild",
  build_image: `docker.io/stellar/stellar-cli@sha256:${"a".repeat(64)}`,
};

let workdir: string;
let deployedPath: string;

beforeEach(async () => {
  getObjectBytesBounded.mockReset();
  workdir = await mkdtemp(join(tmpdir(), "scvs-mismatch-"));
  deployedPath = join(workdir, "target.wasm");
  await writeFile(deployedPath, DEPLOYED);
});

afterEach(async () => {
  await rm(workdir, { recursive: true, force: true });
});

describe("describeWasmMismatch", () => {
  it("names the custom sections each side has and the other does not", () => {
    const compare = describeWasmMismatch(DEPLOYED, REBUILT);

    expect(compare.deployed?.custom_sections).toEqual(["contractmetav0"]);
    expect(compare.rebuilt?.custom_sections).toEqual(["contractspecv0"]);
    expect(compare.custom_section_diff).toEqual({
      only_deployed: ["contractmetav0"],
      only_rebuilt: ["contractspecv0"],
      common: [],
    });
    expect(compare.parse_errors).toBeUndefined();
  });

  it("still summarises the rebuilt side when there is nothing to diff against", () => {
    const compare = describeWasmMismatch(undefined, REBUILT);

    // The half we have is worth publishing: "your build produced this" is actionable alone.
    expect(compare.rebuilt?.custom_sections).toEqual(["contractspecv0"]);
    expect(compare.deployed).toBeUndefined();
    expect(compare.parse_errors?.deployed).toContain("not available");
  });

  it("records an unparseable binary instead of throwing", () => {
    const compare = describeWasmMismatch(DEPLOYED, new Uint8Array([1, 2, 3]));

    expect(compare.parse_errors?.rebuilt).toBeDefined();
    expect(compare.rebuilt).toBeUndefined();
    // The readable side survives, so the submitter still learns something.
    expect(compare.deployed?.custom_sections).toEqual(["contractmetav0"]);
  });

  it("produces something that validates as the DTO it is published inside", () => {
    const compare = describeWasmMismatch(DEPLOYED, REBUILT);
    expect(() =>
      parseDto(SandboxDiagnostics, {
        runner: "docker_build_image_rebuild",
        wasm_compare: compare,
        likely_causes: inferMismatchCauses(compare),
      }),
    ).not.toThrow();
  });
});

describe("MismatchDiagnosticsService", () => {
  it("explains a mismatch and keeps the diagnostics the rebuild already carried", async () => {
    getObjectBytesBounded.mockResolvedValue({ bytes: REBUILT, size: REBUILT.byteLength });

    const explained = await service().describe({
      rebuildId: "rebuild-1",
      buildMode: "build",
      runner: "docker_build_image_rebuild",
      deployedWasmPath: deployedPath,
      existing: EXISTING,
    });

    expect(explained?.build_image).toBe(EXISTING.build_image);
    expect(explained?.wasm_compare?.custom_section_diff?.only_rebuilt).toEqual(["contractspecv0"]);
    expect(explained?.likely_causes?.length).toBeGreaterThan(0);
    // Fetched from this rebuild's own key, at the same ceiling the verdict's hash used.
    expect(getObjectBytesBounded).toHaveBeenCalledWith(
      expect.anything(),
      "scvs-staging",
      "staging/rebuild-1/build/rebuilt.wasm",
      MAX_BYTES,
    );
  });

  it("seeds `runner` from the rebuild when the result carried no diagnostics at all", async () => {
    getObjectBytesBounded.mockResolvedValue({ bytes: REBUILT, size: REBUILT.byteLength });

    const explained = await service().describe({
      rebuildId: "rebuild-1",
      buildMode: "verify",
      runner: "stellar_contract_verify",
      deployedWasmPath: deployedPath,
    });

    // Required field, and the column is validated at publication — so this must be present or the whole object
    // must be withheld.
    expect(explained?.runner).toBe("stellar_contract_verify");
    expect(() => parseDto(SandboxDiagnostics, explained)).not.toThrow();
  });

  it("withholds diagnostics rather than emitting an invalid shape when no runner is known", async () => {
    getObjectBytesBounded.mockResolvedValue({ bytes: REBUILT, size: REBUILT.byteLength });

    const explained = await service().describe({
      rebuildId: "rebuild-1",
      buildMode: "verify",
      runner: "something-a-future-migration-added",
      deployedWasmPath: deployedPath,
    });

    expect(explained).toBeUndefined();
    // And it does not waste the fetch discovering that.
    expect(getObjectBytesBounded).not.toHaveBeenCalled();
  });

  it.each([
    ["the object is gone", async () => undefined],
    ["the object is over the ceiling", async () => ({ tooLarge: MAX_BYTES + 1 })],
    [
      "S3 cannot be reached",
      async () => {
        throw new Error("connection reset");
      },
    ],
  ])("returns nothing when %s, so the mismatch still publishes", async (_label, responder) => {
    getObjectBytesBounded.mockImplementation(responder as never);

    const explained = await service().describe({
      rebuildId: "rebuild-1",
      buildMode: "build",
      runner: "docker_build_image_rebuild",
      deployedWasmPath: deployedPath,
      existing: EXISTING,
    });

    expect(explained).toBeUndefined();
  });

  it("explains what it can when the deployed Wasm is no longer on disk", async () => {
    getObjectBytesBounded.mockResolvedValue({ bytes: REBUILT, size: REBUILT.byteLength });

    const explained = await service().describe({
      rebuildId: "rebuild-1",
      buildMode: "build",
      runner: "docker_build_image_rebuild",
      deployedWasmPath: join(workdir, "does-not-exist.wasm"),
      existing: EXISTING,
    });

    // The CLI's workdir is a temp directory; losing it costs one half of the diff, not the diagnostics.
    expect(explained?.wasm_compare?.rebuilt?.custom_sections).toEqual(["contractspecv0"]);
    expect(explained?.wasm_compare?.parse_errors?.deployed).toBeDefined();
  });
});
