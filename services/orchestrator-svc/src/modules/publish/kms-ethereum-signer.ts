import { getSecp256k1PublicKey, signDigestWithKms, type KmsSendClient } from "@scvs/aws";
import { arrayify, hexlify, joinSignature } from "@ethersproject/bytes";
import { hashMessage } from "@ethersproject/hash";
import { recoverPublicKey } from "@ethersproject/signing-key";
import { computeAddress } from "@ethersproject/transactions";
import { EthereumToken } from "@irys/upload-ethereum";

const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const SECP256K1_HALF_N = SECP256K1_N >> 1n;

// @irys/bundles SignatureConfig.ETHEREUM.
const IRYS_ETHEREUM_SIGNATURE_TYPE = 3;

function readDerInteger(der: Uint8Array, offset: number): { value: bigint; next: number } {
  if (der[offset] !== 0x02) throw new Error("DER signature: expected an INTEGER");
  const length = der[offset + 1];
  if (length === undefined || length < 1 || length > 33 || offset + 2 + length > der.length) {
    throw new Error("DER signature: malformed INTEGER length");
  }
  const bytes = der.subarray(offset + 2, offset + 2 + length);
  return { value: BigInt(hexlify(bytes)), next: offset + 2 + length };
}

export function parseDerSignature(der: Uint8Array): { r: bigint; s: bigint } {
  if (der[0] !== 0x30 || der[1] !== der.length - 2) throw new Error("DER signature: expected a SEQUENCE spanning the input");
  const r = readDerInteger(der, 2);
  const s = readDerInteger(der, r.next);
  if (s.next !== der.length) throw new Error("DER signature: trailing bytes");
  if (r.value === 0n || r.value >= SECP256K1_N || s.value === 0n || s.value >= SECP256K1_N) {
    throw new Error("DER signature: r or s out of range");
  }
  return { r: r.value, s: s.value };
}

const toWord = (value: bigint): string => `0x${value.toString(16).padStart(64, "0")}`;

/** 65-byte r ‖ s ‖ v: low-s (Irys's verifier rejects high-s), with v found by recovering against the key's own point. */
export function toEthereumSignature(digest: Uint8Array, der: Uint8Array, publicKey: Uint8Array): Uint8Array {
  const { r, s } = parseDerSignature(der);
  const lowS = s > SECP256K1_HALF_N ? SECP256K1_N - s : s;
  const expected = hexlify(publicKey).toLowerCase();
  for (const v of [27, 28]) {
    const signature = joinSignature({ r: toWord(r), s: toWord(lowS), v });
    if (recoverPublicKey(digest, signature).toLowerCase() === expected) return arrayify(signature);
  }
  throw new Error("KMS signature does not recover to the key's public key");
}

/** An Irys data-item signer whose secp256k1 key never leaves AWS KMS; signs exactly as Irys's own EthereumSigner (EIP-191). */
export class KmsEthereumSigner {
  readonly ownerLength = 65;
  readonly signatureLength = 65;
  readonly signatureType = IRYS_ETHEREUM_SIGNATURE_TYPE;
  readonly publicKey: Buffer;
  readonly address: string;

  private constructor(
    private readonly kms: KmsSendClient,
    private readonly keyId: string,
    publicKey: Uint8Array,
  ) {
    this.publicKey = Buffer.from(publicKey);
    // Lowercase, as Irys's own ownerToAddress derives it; findExistingUpload queries by this exact string.
    this.address = computeAddress(publicKey).toLowerCase();
  }

  static async create(kms: KmsSendClient, keyId: string): Promise<KmsEthereumSigner> {
    return new KmsEthereumSigner(kms, keyId, await getSecp256k1PublicKey(kms, keyId));
  }

  async sign(message: Uint8Array): Promise<Uint8Array> {
    const digest = arrayify(hashMessage(message));
    const der = await signDigestWithKms(this.kms, this.keyId, digest);
    return Buffer.from(toEthereumSignature(digest, der, this.publicKey));
  }
}

// Stands in for the wallet the token constructor demands; only the funding path reads it, and that path is closed.
export const KMS_WALLET_PLACEHOLDER = "kms-signer-holds-no-private-key";

/** An Irys Ethereum token that signs through `signer` instead of a private key held in process memory. */
export function kmsEthereumToken(signer: KmsEthereumSigner): typeof EthereumToken {
  return class KmsEthereumToken extends EthereumToken {
    override getSigner() {
      return signer as unknown as ReturnType<EthereumToken["getSigner"]>;
    }

    override getPublicKey(): Buffer {
      return signer.publicKey;
    }

    override get address(): string {
      return signer.address;
    }

    override async createTx(): Promise<never> {
      throw new Error("the KMS-signed archiving wallet never funds itself; fund it from outside this service");
    }
  };
}
