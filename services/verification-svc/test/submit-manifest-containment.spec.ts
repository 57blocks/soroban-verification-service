import { jest } from "@jest/globals";
import { SubmitService } from "../src/modules/verifications/submit.service.js";

describe("SubmitService submitted manifest containment", () => {
  it("rejects an escaping manifest path before reading or creating a job", async () => {
    const jobs = {
      getActiveJobForTarget: jest.fn(),
      createJob: jest.fn(),
    };
    const uploads = {
      getUpload: jest.fn(),
      setUploadVisibility: jest.fn(),
    };
    const uploadJobReferences = { recordReference: jest.fn() };
    const configService = { get: jest.fn() };
    // Accepts unconditionally: a terms rejection would short-circuit ahead of the manifest gate.
    const legal = { checkAcceptance: jest.fn(() => ({ accepted: true })) };
    const service = new SubmitService(
      configService as never,
      jobs as never,
      uploads as never,
      uploadJobReferences as never,
      legal as never,
    );

    const response = await service.submit({
      target: {
        network: "testnet",
        wasm_hash: "8ecd1857496df2c15aaab4d18d2d7689542a62814245e9b2c613c609b86bd11c",
      },
      manifest: {
        schema: "stellar-submitted-source-verification-manifest-v1",
        source_sha256: "a".repeat(64),
        source_uri: "https://example.test/source.tar.gz",
        bldopt: ["--manifest-path=../../outside/Cargo.toml"],
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.body).toMatchObject({ error: "policy_rejected", status_code: 400 });
    expect(jobs.getActiveJobForTarget).not.toHaveBeenCalled();
    expect(jobs.createJob).not.toHaveBeenCalled();
    expect(uploads.getUpload).not.toHaveBeenCalled();
    expect(uploads.setUploadVisibility).not.toHaveBeenCalled();
    expect(uploadJobReferences.recordReference).not.toHaveBeenCalled();
  });
});
