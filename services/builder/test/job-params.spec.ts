import { jest } from "@jest/globals";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BatchJobParams, MaterialiseJobParams } from "@scvs/core";
import { jobParamsInput, readJobParams } from "../src/modules/builder/job-params.js";

const materialise = {
  job_id: "11111111-2222-3333-4444-555555555555",
  source_ref: {
    type: "private_tarball",
    visibility: "private",
    tarball_sha256: "b".repeat(64),
    upload_id: "66666666-7777-8888-9999-000000000000",
    source_uri: "https://sv-dev-scratch.s3.ap-southeast-2.amazonaws.com/staging/uploads/u/source.tar.gz?X-Amz-Signature=abc",
  },
  mode: "verify",
} satisfies Record<string, unknown>;

const PARAMS_URL =
  "https://sv-dev-scratch.s3.ap-southeast-2.amazonaws.com/staging/r1/verify/params/materialise.json?X-Amz-Signature=abc";

function okResponse(body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, { status: 200, headers });
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe("readJobParams — the inline leg (unchanged)", () => {
  it("still parses an inline SCVS_JOB_PARAMS_JSON value", async () => {
    const parsed = await readJobParams(MaterialiseJobParams, JSON.stringify(materialise));
    expect(parsed.job_id).toBe(materialise.job_id);
  });

  it("still reads argv[2] as a local file path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "scvs-job-params-"));
    const path = join(dir, "params.json");
    await writeFile(path, JSON.stringify(materialise), "utf8");
    const originalArgv = process.argv;
    process.argv = ["node", "entrypoint.js", path];
    try {
      const parsed = await readJobParams(MaterialiseJobParams, undefined);
      expect(parsed.job_id).toBe(materialise.job_id);
    } finally {
      process.argv = originalArgv;
    }
  });
});

describe("readJobParams — the presigned URL leg", () => {
  it("fetches the blob when the value is an https URL, and parses it as the same document", async () => {
    const fetchMock = jest.fn(async () => okResponse(JSON.stringify(materialise)));
    jest.spyOn(globalThis, "fetch").mockImplementation(fetchMock);

    const parsed = await readJobParams(MaterialiseJobParams, PARAMS_URL);

    expect(parsed.job_id).toBe(materialise.job_id);
    expect(fetchMock).toHaveBeenCalledWith(
      PARAMS_URL,
      expect.objectContaining({ method: "GET", redirect: "error" }),
    );
  });

  it("fails on a non-2xx answer WITHOUT echoing the URL — it is a presigned capability", async () => {
    jest.spyOn(globalThis, "fetch").mockImplementation(
      async () => new Response("gone", { status: 403 }),
    );

    await expect(readJobParams(MaterialiseJobParams, PARAMS_URL)).rejects.toThrow(
      /HTTP 403/,
    );
    try {
      await readJobParams(MaterialiseJobParams, PARAMS_URL);
      throw new Error("expected a rejection");
    } catch (error) {
      expect((error as Error).message).not.toContain("X-Amz-Signature");
      expect((error as Error).message).not.toContain(PARAMS_URL);
    }
  });

  it("refuses a blob over the size bound rather than buffering it", async () => {
    const stream = new ReadableStream({
      start(controller) {
        // Well over the 64 KiB bound, delivered in chunks so the cap must act mid-stream.
        const chunk = "x".repeat(8 * 1024);
        for (let i = 0; i < 20; i++) controller.enqueue(new TextEncoder().encode(chunk));
        controller.close();
      },
    });
    jest.spyOn(globalThis, "fetch").mockImplementation(
      async () => new Response(stream, { status: 200 }),
    );

    await expect(readJobParams(MaterialiseJobParams, PARAMS_URL)).rejects.toThrow(
      /exceeds \d+ bytes/,
    );
  });

  it("validates the fetched document against the DTO like an inline one", async () => {
    // A document with no job_id validates against neither half's class — the URL leg must not weaken validation
    // the inline leg performs.
    jest.spyOn(globalThis, "fetch").mockImplementation(
      async () => okResponse(JSON.stringify({ mode: "verify" })),
    );
    await expect(readJobParams(MaterialiseJobParams, PARAMS_URL)).rejects.toThrow();
    await expect(readJobParams(BatchJobParams, PARAMS_URL)).rejects.toThrow();
  });
});

describe("jobParamsInput — the transitional priority", () => {
  it("prefers the URL variable when set, the inline JSON otherwise", () => {
    expect(jobParamsInput(PARAMS_URL, "{}")).toBe(PARAMS_URL);
    expect(jobParamsInput(undefined, "{}")).toBe("{}");
    expect(jobParamsInput("   ", "{}")).toBe("{}");
    expect(jobParamsInput(undefined, undefined)).toBeUndefined();
  });
});
