import { jest } from "@jest/globals";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

jest.unstable_mockModule("@scvs/aws", () => ({
  createS3Client: () => ({}),
  putObjectBytes: async () => undefined,
  deleteObject: async () => undefined,
  listObjectKeys: async () => [],
}));
jest.unstable_mockModule("@scvs/config", () => ({
  getStagingStorageConfig: () => ({ bucket: "test-bucket", region: "us-east-1" }),
}));

const { UploadsService } = await import("../src/modules/verifications/uploads.service.js");

describe("an upload returns a secret once and keeps only its hash", () => {
  it("hands the secret to the uploader and stores its SHA-256, never the secret", async () => {
    const created: { id: string; secretSha256?: string }[] = [];
    const uploads = {
      createUpload: async (input: { id: string; secretSha256?: string }) => void created.push(input),
      markUploadReceived: async () => undefined,
    };
    const config = { get: () => 52_428_800 };
    const service = new UploadsService(config as never, uploads as never);

    const res = await service.receive(gzipSync(Buffer.from("tar bytes")), "src.tar.gz");
    const body = res.body as { upload_id: string; upload_secret: string };

    expect(res.statusCode).toBe(201);
    expect(body.upload_secret.length).toBeGreaterThanOrEqual(43);
    expect(created).toHaveLength(1);
    expect(created[0].id).toBe(body.upload_id);
    expect(created[0].secretSha256).toBe(createHash("sha256").update(body.upload_secret).digest("hex"));
    expect(JSON.stringify(created[0])).not.toContain(body.upload_secret);
  });
});
