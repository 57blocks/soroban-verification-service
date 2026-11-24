import { SigningKey } from "@ethersproject/signing-key";
import { id } from "@ethersproject/hash";
import type { KmsSendClient } from "@scvs/aws";
import { ArweaveArchiveService } from "../src/modules/publish/arweave-archive.service.js";
import type { AppConfigService } from "../src/config/configuration.js";

const SPKI_PREFIX = "3056301006072a8648ce3d020106052b8104000a034200";
const KEY_ARN = "arn:aws:kms:ap-southeast-2:000000000000:key/11111111-2222-3333-4444-555555555555";
const PUBLIC_KEY = new SigningKey(id("scvs arweave-kms-wiring spec key")).publicKey;

type Arweave = { mode: string; network: string; signer: string; kmsKeyId?: string; rpcUrl?: string; gatewayUrl: string };

function configWith(arweave: Partial<Arweave>, awsRegion: string | null = "ap-southeast-2"): AppConfigService {
  const values: Record<string, unknown> = {
    arweave: { mode: "irys", network: "devnet", signer: "kms", kmsKeyId: KEY_ARN, gatewayUrl: "https://gateway.irys.xyz", ...arweave },
    awsRegion: awsRegion ?? undefined,
  };
  return { get: (key: string) => values[key] } as unknown as AppConfigService;
}

class FakeKms {
  getPublicKeyCalls = 0;
  constructor(private readonly behaviour: "ok" | "throw" | "wrong-key") {}
  async send(command: { constructor: { name: string } }) {
    if (command.constructor.name !== "GetPublicKeyCommand") throw new Error(`unexpected ${command.constructor.name}`);
    this.getPublicKeyCalls += 1;
    if (this.behaviour === "throw") throw new Error("ThrottlingException");
    return {
      KeySpec: this.behaviour === "wrong-key" ? "ECC_NIST_P256" : "ECC_SECG_P256K1",
      KeyUsage: "SIGN_VERIFY",
      PublicKey: Buffer.from(SPKI_PREFIX + PUBLIC_KEY.slice(2), "hex"),
    };
  }
}

class TestableArchive extends ArweaveArchiveService {
  readonly clientRequests: string[] = [];
  constructor(config: AppConfigService, private readonly kms: FakeKms) {
    super(config, {} as never, {} as never, {} as never);
  }
  protected override kmsClient(keyId: string): KmsSendClient {
    this.clientRequests.push(keyId);
    return this.kms as unknown as KmsSendClient;
  }
}

const internals = (service: ArweaveArchiveService) =>
  service as unknown as {
    getUploader(): Promise<unknown>;
    findExistingUpload(kind: "report" | "source", sha: string): Promise<unknown>;
    kmsClient(keyId: string): KmsSendClient;
  };

describe("ArweaveArchiveService with the KMS signer", () => {
  it("reads the KMS public key at boot, once", async () => {
    const kms = new FakeKms("ok");
    const service = new TestableArchive(configWith({}), kms);

    await service.onModuleInit();
    await service.onModuleInit();

    expect(kms.getPublicKeyCalls).toBe(1);
    expect(service.clientRequests).toEqual([KEY_ARN]);
  });

  it("fails the boot when the key is not a secp256k1 signing key", async () => {
    await expect(new TestableArchive(configWith({}), new FakeKms("wrong-key")).onModuleInit()).rejects.toThrow(
      /needs ECC_SECG_P256K1\/SIGN_VERIFY/,
    );
  });

  it("fails the boot when KMS cannot be reached", async () => {
    await expect(new TestableArchive(configWith({}), new FakeKms("throw")).onModuleInit()).rejects.toThrow(/ThrottlingException/);
  });

  it.each([
    ["the private-key signer", { signer: "private-key" }],
    ["archiving that is not irys", { mode: "dry-run" }],
  ])("never touches KMS for %s", async (_label, arweave) => {
    const kms = new FakeKms("ok");
    const service = new TestableArchive(configWith(arweave), kms);
    await service.onModuleInit();
    expect(kms.getPublicKeyCalls).toBe(0);
  });

  it("retries a failed uploader build instead of keeping the rejection", async () => {
    const kms = new FakeKms("throw");
    const service = new TestableArchive(configWith({}), kms);

    await expect(internals(service).getUploader()).rejects.toThrow(/ThrottlingException/);
    await expect(internals(service).getUploader()).rejects.toThrow(/ThrottlingException/);

    expect(kms.getPublicKeyCalls).toBe(2);
  });

  it("treats an uploader that cannot be built as no lookup result, so the claim holder can release its claim", async () => {
    const service = new TestableArchive(configWith({}), new FakeKms("throw"));
    await expect(internals(service).findExistingUpload("report", "a".repeat(64))).resolves.toBeUndefined();
  });
});

describe("kmsClient region", () => {
  const base = (awsRegion: string | null, kmsKeyId: string) =>
    internals(new ArweaveArchiveService(configWith({ kmsKeyId }, awsRegion), {} as never, {} as never, {} as never));

  it("takes the region from a key ARN over AWS_REGION", async () => {
    const client = base("us-east-1", KEY_ARN).kmsClient(KEY_ARN) as unknown as { config: { region(): Promise<string> } };
    await expect(client.config.region()).resolves.toBe("ap-southeast-2");
  });

  it("falls back to AWS_REGION for an alias name", async () => {
    const client = base("eu-west-1", "alias/x").kmsClient("alias/x") as unknown as { config: { region(): Promise<string> } };
    await expect(client.config.region()).resolves.toBe("eu-west-1");
  });

  it("refuses to guess a region for an alias name with no AWS_REGION", () => {
    expect(() => base(null, "alias/x").kmsClient("alias/x")).toThrow(/AWS_REGION is unset/);
  });
});
