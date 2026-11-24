import { arrayify, hexlify, joinSignature } from "@ethersproject/bytes";
import { hashMessage, id } from "@ethersproject/hash";
import { SigningKey } from "@ethersproject/signing-key";
import { computeAddress, recoverAddress } from "@ethersproject/transactions";
import type { KmsSendClient } from "@scvs/aws";
import {
  KMS_WALLET_PLACEHOLDER,
  KmsEthereumSigner,
  kmsEthereumToken,
  parseDerSignature,
  toEthereumSignature,
} from "../src/modules/publish/kms-ethereum-signer.js";

const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
// Derived, not written out: a literal key in the tree is indistinguishable from a leaked one.
const PRIVATE_KEY = id("scvs kms-ethereum-signer spec key");
const SPKI_PREFIX = "3056301006072a8648ce3d020106052b8104000a034200";
const KEY_ID = "arn:aws:kms:ap-southeast-2:000000000000:key/test";

function derInteger(value: bigint): Buffer {
  let hex = value.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  let bytes = Buffer.from(hex, "hex");
  if (bytes[0]! & 0x80) bytes = Buffer.concat([Buffer.from([0]), bytes]);
  return Buffer.concat([Buffer.from([0x02, bytes.length]), bytes]);
}

function derSignature(r: bigint, s: bigint): Uint8Array {
  const body = Buffer.concat([derInteger(r), derInteger(s)]);
  return Buffer.concat([Buffer.from([0x30, body.length]), body]);
}

type FakeKmsOptions = { highS?: boolean; keySpec?: string; keyUsage?: string };

function fakeKms(options: FakeKmsOptions = {}): KmsSendClient & { signCalls: Record<string, unknown>[] } {
  const key = new SigningKey(PRIVATE_KEY);
  const signCalls: Record<string, unknown>[] = [];
  const send = async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
    if (command.constructor.name === "GetPublicKeyCommand") {
      return {
        KeySpec: options.keySpec ?? "ECC_SECG_P256K1",
        KeyUsage: options.keyUsage ?? "SIGN_VERIFY",
        PublicKey: Buffer.from(SPKI_PREFIX + key.publicKey.slice(2), "hex"),
      };
    }
    if (command.constructor.name === "SignCommand") {
      signCalls.push(command.input);
      const sig = key.signDigest(command.input.Message as Uint8Array);
      const r = BigInt(sig.r);
      const s = BigInt(sig.s);
      return { Signature: derSignature(r, options.highS ? N - s : s) };
    }
    throw new Error(`unexpected command ${command.constructor.name}`);
  };
  return { send, signCalls } as unknown as KmsSendClient & { signCalls: Record<string, unknown>[] };
}

const walletSignature = (message: Uint8Array): string =>
  joinSignature(new SigningKey(PRIVATE_KEY).signDigest(hashMessage(message)));

describe("parseDerSignature", () => {
  it("reads r and s, including a leading zero byte on a high-bit integer", () => {
    const r = 0x80n << 248n;
    expect(parseDerSignature(derSignature(r, 5n))).toEqual({ r, s: 5n });
  });

  it("rejects trailing bytes, a wrong tag and out-of-range values", () => {
    const good = derSignature(7n, 9n);
    expect(() => parseDerSignature(Buffer.concat([good, Buffer.from([0])]))).toThrow(/SEQUENCE/);
    expect(() => parseDerSignature(Buffer.from([0x31, ...good.subarray(1)]))).toThrow(/SEQUENCE/);
    expect(() => parseDerSignature(derSignature(0n, 9n))).toThrow(/out of range/);
    expect(() => parseDerSignature(derSignature(7n, N))).toThrow(/out of range/);
  });
});

describe("toEthereumSignature", () => {
  const key = new SigningKey(PRIVATE_KEY);
  const digest = arrayify(hashMessage("hello"));
  const sig = key.signDigest(digest);

  it("normalises a high-s signature to low-s and finds v", () => {
    const highS = derSignature(BigInt(sig.r), N - BigInt(sig.s));
    expect(hexlify(toEthereumSignature(digest, highS, arrayify(key.publicKey)))).toBe(joinSignature(sig));
  });

  it("refuses a signature from a different key", () => {
    const other = new SigningKey(`0x${"11".repeat(32)}`).signDigest(digest);
    expect(() =>
      toEthereumSignature(digest, derSignature(BigInt(other.r), BigInt(other.s)), arrayify(key.publicKey)),
    ).toThrow(/does not recover/);
  });
});

describe("KmsEthereumSigner", () => {
  it("derives the wallet address from the KMS public key, lowercased", async () => {
    const signer = await KmsEthereumSigner.create(fakeKms(), KEY_ID);
    expect(signer.address).toBe(computeAddress(PRIVATE_KEY).toLowerCase());
    expect(signer.publicKey).toHaveLength(65);
  });

  it.each([false, true])("signs exactly as a private-key wallet's EIP-191 signMessage (KMS returns high-s: %s)", async (highS) => {
    const kms = fakeKms({ highS });
    const signer = await KmsEthereumSigner.create(kms, KEY_ID);
    const message = new TextEncoder().encode("an Irys data item's deep hash");

    const signature = await signer.sign(message);

    expect(hexlify(signature)).toBe(walletSignature(message));
    expect(recoverAddress(hashMessage(message), signature).toLowerCase()).toBe(signer.address);
    expect(kms.signCalls).toEqual([
      expect.objectContaining({ KeyId: KEY_ID, MessageType: "DIGEST", SigningAlgorithm: "ECDSA_SHA_256" }),
    ]);
  });

  it("refuses a key that is not a secp256k1 signing key", async () => {
    await expect(KmsEthereumSigner.create(fakeKms({ keySpec: "ECC_NIST_P256" }), KEY_ID)).rejects.toThrow(
      /needs ECC_SECG_P256K1\/SIGN_VERIFY/,
    );
    await expect(KmsEthereumSigner.create(fakeKms({ keyUsage: "ENCRYPT_DECRYPT" }), KEY_ID)).rejects.toThrow(
      /needs ECC_SECG_P256K1\/SIGN_VERIFY/,
    );
  });
});

describe("kmsEthereumToken", () => {
  async function token() {
    const signer = await KmsEthereumSigner.create(fakeKms({ highS: true }), KEY_ID);
    const Token = kmsEthereumToken(signer);
    const instance = new Token({ irys: {} as never, wallet: KMS_WALLET_PLACEHOLDER, providerUrl: "http://127.0.0.1:1" } as never);
    return { signer, instance };
  }

  it("reports the KMS address, the same string Irys derives from the owner bytes", async () => {
    const { signer, instance } = await token();
    expect(instance.address).toBe(signer.address);
    expect(await instance.ownerToAddress(instance.getPublicKey())).toBe(signer.address);
  });

  it("produces signatures Irys's own Ethereum verifier accepts", async () => {
    const { instance } = await token();
    const data = new TextEncoder().encode("payload");
    const signature = await instance.sign(data);
    expect(await instance.verify(instance.getPublicKey(), data, signature)).toBe(true);
  });

  it("never builds a funding transaction", async () => {
    const { instance } = await token();
    await expect(instance.createTx(1, "0x0000000000000000000000000000000000000001")).rejects.toThrow(/never funds itself/);
  });
});
