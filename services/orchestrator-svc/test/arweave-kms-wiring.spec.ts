import { SigningKey } from "@ethersproject/signing-key";
import { id } from "@ethersproject/hash";
import type { KmsSendClient } from "@scvs/aws";
import { ArweaveArchiveService } from "../src/modules/publish/arweave-archive.service.js";
import type { AppConfigService } from "../src/config/configuration.js";

const SPKI_PREFIX = "3056301006072a8648ce3d020106052b8104000a034200";
const KEY_ARN = "arn:aws:kms:ap-southeast-2:000000000000:key/11111111-2222-3333-4444-555555555555";
const PUBLIC_KEY = new SigningKey(id("scvs arweave-kms-wiring spec key")).publicKey;

type Arweave = { mode: string; network: string; signer: string; kmsKeyId?: string; paidBy?: string; gatewayUrl: string };

function configWith(arweave: Partial<Arweave>, awsRegion: string | null = "ap-southeast-2"): AppConfigService {
  const values: Record<string, unknown> = {
    arweave: {
      mode: "turbo",
      network: "devnet",
      signer: "kms",
      kmsKeyId: KEY_ARN,
      gatewayUrl: "https://ar-io.dev",
      turbo: { uploadUrl: "http://127.0.0.1:1", paymentUrl: "http://127.0.0.1:1" },
      ...arweave,
    },
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
    ["archiving that is not turbo", { mode: "dry-run" }],
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

const PAYER = "0x00000000000000000000000000000000000000aa";
const SIGNER_ADDRESS = "0x00000000000000000000000000000000000000bb";

function fakeUploader(answer: "stored" | "insufficient_credits" | Error) {
  const uploads: { tags: unknown; paidBy?: string }[] = [];
  return {
    uploads,
    address: SIGNER_ADDRESS,
    ownerKey: "our-owner-key",
    upload: async (_data: Buffer, tags: unknown, paidBy?: string) => {
      uploads.push({ tags, paidBy });
      if (answer instanceof Error) throw answer;
      return answer === "stored" ? { ok: true as const, id: "turbo-item-1" } : { ok: false as const, reason: answer };
    },
  };
}

function archiveWith(paidBy: string | undefined, uploader: ReturnType<typeof fakeUploader>) {
  const service = new ArweaveArchiveService(configWith({ paidBy }), {} as never, {} as never, {} as never);
  (service as unknown as { getUploader: () => Promise<unknown> }).getUploader = async () => uploader;
  const upload = () =>
    (service as unknown as {
      uploadToTurbo(kind: "report", input: Record<string, unknown>): Promise<{ ok: boolean; reason?: string; detail?: string; tx_id?: string; archive_url?: string }>;
    }).uploadToTurbo("report", { wasmHash: "w", contentSha256: "c".repeat(64), bytes: "{}", verifierId: "v" });
  return { upload };
}

describe("uploading on credits another wallet shared", () => {
  it("bills the payer, without checking any balance first", async () => {
    const uploader = fakeUploader("stored");

    await expect(archiveWith(PAYER, uploader).upload()).resolves.toMatchObject({
      ok: true,
      tx_id: "turbo-item-1",
      archive_url: "https://ar-io.dev/turbo-item-1",
    });

    expect(uploader.uploads).toEqual([{ tags: expect.arrayContaining([{ name: "Report_Hash", value: "c".repeat(64) }]), paidBy: PAYER }]);
  });

  it("reports a 402 as insufficient balance, naming the payer", async () => {
    const outcome = await archiveWith(PAYER, fakeUploader("insufficient_credits")).upload();
    expect(outcome).toMatchObject({ ok: false, reason: "insufficient_balance" });
    expect(outcome.detail).toMatch(new RegExp(`${PAYER} holds or has shared too few with ${SIGNER_ADDRESS}`));
  });

  it("reports any other failure as a failed upload", async () => {
    const outcome = await archiveWith(PAYER, fakeUploader(new Error("socket hang up"))).upload();
    expect(outcome).toMatchObject({ ok: false, reason: "upload_failed", detail: "socket hang up" });
  });

  it("without a payer, the signer is billed", async () => {
    const uploader = fakeUploader("stored");
    await expect(archiveWith(undefined, uploader).upload()).resolves.toMatchObject({ ok: true });
    expect(uploader.uploads[0]?.paidBy).toBeUndefined();
  });
});

describe("finding an item this verifier already uploaded", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("matches on the owner's key, so an item someone else tagged the same way is not taken for ours", async () => {
    const seen: { query: string; variables: unknown }[] = [];
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      seen.push(JSON.parse(String(init?.body)));
      return Response.json({
        data: {
          transactions: {
            edges: [
              { node: { id: "someone-elses", owner: { key: "their-owner-key" } } },
              { node: { id: "ours", owner: { key: "our-owner-key" } } },
            ],
          },
        },
      });
    }) as typeof fetch;
    const service = new ArweaveArchiveService(configWith({}), {} as never, {} as never, {} as never);
    (service as unknown as { getUploader: () => Promise<unknown> }).getUploader = async () => fakeUploader("stored");
    const found = await (service as unknown as {
      findExistingUpload(kind: "report", sha: string): Promise<{ tx_id: string } | undefined>;
    }).findExistingUpload("report", "c".repeat(64));
    expect(found?.tx_id).toBe("ours");
    expect(seen[0]?.variables).toEqual({
      tags: [
        { name: "App-Name", values: ["Stellar-Verifier"] },
        { name: "Report_Hash", values: ["c".repeat(64)] },
      ],
    });
  });

  it("finds nothing when only others' items carry the tags", async () => {
    globalThis.fetch = (async () =>
      Response.json({ data: { transactions: { edges: [{ node: { id: "someone-elses", owner: { key: "their-owner-key" } } }] } } })) as typeof fetch;
    const service = new ArweaveArchiveService(configWith({}), {} as never, {} as never, {} as never);
    (service as unknown as { getUploader: () => Promise<unknown> }).getUploader = async () => fakeUploader("stored");
    const found = await (service as unknown as {
      findExistingUpload(kind: "report", sha: string): Promise<unknown>;
    }).findExistingUpload("report", "c".repeat(64));
    expect(found).toBeUndefined();
  });
});
