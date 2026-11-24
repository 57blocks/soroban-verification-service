import { SigningKey } from "@ethersproject/signing-key";
import { id } from "@ethersproject/hash";
import type { KmsSendClient } from "@scvs/aws";
import { ArweaveArchiveService } from "../src/modules/publish/arweave-archive.service.js";
import type { AppConfigService } from "../src/config/configuration.js";

const SPKI_PREFIX = "3056301006072a8648ce3d020106052b8104000a034200";
const KEY_ARN = "arn:aws:kms:ap-southeast-2:000000000000:key/11111111-2222-3333-4444-555555555555";
const PUBLIC_KEY = new SigningKey(id("scvs arweave-kms-wiring spec key")).publicKey;

type Arweave = { mode: string; network: string; signer: string; kmsKeyId?: string; paidBy?: string; rpcUrl?: string; gatewayUrl: string };

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

const big = (value: number | string) => {
  const n = BigInt(value);
  const of = (other: unknown) => BigInt(String(other));
  return { lt: (o: unknown) => n < of(o), gt: (o: unknown) => n > of(o), toString: () => n.toString() };
};

const PAYER = "0x00000000000000000000000000000000000000aa";
const SIGNER_ADDRESS = "0x00000000000000000000000000000000000000bb";

function fakeUploader(funds: { price: number; signer?: number; payer?: number; approved?: number }) {
  const uploads: { tags: unknown; upload?: { paidBy?: string } }[] = [];
  const balanceQueries: (string | undefined)[] = [];
  return {
    uploads,
    balanceQueries,
    address: SIGNER_ADDRESS,
    getPrice: async () => big(funds.price),
    getBalance: async (address?: string) => {
      balanceQueries.push(address);
      return big(address === undefined ? (funds.signer ?? 0) : (funds.payer ?? 0));
    },
    approval: { getApprovedBalanceFrom: async (payer: string) => ({ amount: payer === PAYER ? String(funds.approved ?? 0) : "0" }) },
    upload: async (_body: unknown, opts: { tags: unknown; upload?: { paidBy?: string } }) => {
      uploads.push(opts);
      return { id: "irys-tx-1" };
    },
  };
}

function archiveWith(paidBy: string | undefined, uploader: ReturnType<typeof fakeUploader>) {
  const service = new ArweaveArchiveService(configWith({ paidBy }), {} as never, {} as never, {} as never);
  (service as unknown as { getUploader: () => Promise<unknown> }).getUploader = async () => uploader;
  const upload = () =>
    (service as unknown as {
      uploadToIrys(kind: "report", input: Record<string, unknown>): Promise<{ ok: boolean; reason?: string; detail?: string; tx_id?: string }>;
    }).uploadToIrys("report", { wasmHash: "w", contentSha256: "c".repeat(64), bytes: "{}", verifierId: "v" });
  return { upload };
}

describe("uploading paid through another wallet's approval", () => {
  it("charges the payer and checks its approval, not the signer's balance", async () => {
    const uploader = fakeUploader({ price: 10, signer: 0, payer: 100, approved: 50 });

    await expect(archiveWith(PAYER, uploader).upload()).resolves.toMatchObject({ ok: true, tx_id: "irys-tx-1" });

    expect(uploader.uploads[0]?.upload).toEqual({ paidBy: PAYER });
    expect(uploader.balanceQueries).toEqual([PAYER]);
  });

  it("stops when the approval no longer covers the upload", async () => {
    const uploader = fakeUploader({ price: 10, payer: 100, approved: 9 });
    const outcome = await archiveWith(PAYER, uploader).upload();
    expect(outcome).toMatchObject({ ok: false, reason: "insufficient_balance" });
    expect(outcome.detail).toMatch(/approval .* is below the price .* renew it with createApproval/);
    expect(uploader.uploads).toHaveLength(0);
  });

  it("stops when the payer itself holds less than the approval allows", async () => {
    const uploader = fakeUploader({ price: 10, payer: 5, approved: 50 });
    const outcome = await archiveWith(PAYER, uploader).upload();
    expect(outcome).toMatchObject({ ok: false, reason: "insufficient_balance" });
    expect(outcome.detail).toMatch(/Paying wallet .* holds less than the price/);
    expect(uploader.uploads).toHaveLength(0);
  });

  it("without a payer, the signer pays from its own balance as before", async () => {
    const uploader = fakeUploader({ price: 10, signer: 20 });
    await expect(archiveWith(undefined, uploader).upload()).resolves.toMatchObject({ ok: true });
    expect(uploader.uploads[0]?.upload).toBeUndefined();
    expect(uploader.balanceQueries).toEqual([undefined]);
  });
});
