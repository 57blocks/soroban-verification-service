import { arrayify, hexlify, joinSignature, type SignatureLike } from "@ethersproject/bytes";
import { hashMessage } from "@ethersproject/hash";
import { keccak256 } from "@ethersproject/keccak256";
import { recoverPublicKey, SigningKey } from "@ethersproject/signing-key";
import { computeAddress, serialize, type UnsignedTransaction } from "@ethersproject/transactions";
import { getSecp256k1PublicKey, signDigestWithKms, type KmsSendClient } from "./kms.js";

const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const SECP256K1_HALF_N = SECP256K1_N >> 1n;

// ANS-104's signature type for an Ethereum (secp256k1, EIP-191) data item.
const ETHEREUM_SIGNATURE_TYPE = 3;

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

/** r, s (normalised to low-s, which both ANS-104 verifiers and EIP-2 require) and the recovery bit that recovers the key's own point. */
export function ethereumSignatureParts(
  digest: Uint8Array,
  der: Uint8Array,
  publicKey: Uint8Array,
): { r: string; s: string; recoveryParam: 0 | 1 } {
  const { r, s } = parseDerSignature(der);
  const lowS = s > SECP256K1_HALF_N ? SECP256K1_N - s : s;
  const expected = hexlify(publicKey).toLowerCase();
  for (const recoveryParam of [0, 1] as const) {
    const signature = joinSignature({ r: toWord(r), s: toWord(lowS), recoveryParam });
    if (recoverPublicKey(digest, signature).toLowerCase() === expected) return { r: toWord(r), s: toWord(lowS), recoveryParam };
  }
  throw new Error("KMS signature does not recover to the key's public key");
}

/** 65-byte r ‖ s ‖ v with v = 27 | 28, as an Ethereum data-item signer produces. */
export function toEthereumSignature(digest: Uint8Array, der: Uint8Array, publicKey: Uint8Array): Uint8Array {
  return arrayify(joinSignature(ethereumSignatureParts(digest, der, publicKey) as SignatureLike));
}

/**
 * A secp256k1 key held in AWS KMS, used as an Ethereum account. Signs ANS-104 data items exactly as the reference
 * EthereumSigner does (EIP-191), and — for the one caller allowed to move funds — EIP-1559 transactions.
 */
export class KmsEthereumSigner {
  readonly ownerLength = 65;
  readonly signatureLength = 65;
  readonly signatureType = ETHEREUM_SIGNATURE_TYPE;
  readonly publicKey: Buffer;
  readonly address: string;

  private constructor(
    private readonly kms: KmsSendClient,
    private readonly keyId: string,
    publicKey: Uint8Array,
  ) {
    this.publicKey = Buffer.from(publicKey);
    // Turbo compares addresses lowercased; a checksummed one would never match.
    this.address = computeAddress(publicKey).toLowerCase();
  }

  static async create(kms: KmsSendClient, keyId: string): Promise<KmsEthereumSigner> {
    return new KmsEthereumSigner(kms, keyId, await getSecp256k1PublicKey(kms, keyId));
  }

  /** Data-item signature (EIP-191 personal message). */
  async sign(message: Uint8Array): Promise<Uint8Array> {
    const digest = arrayify(hashMessage(message));
    const der = await signDigestWithKms(this.kms, this.keyId, digest);
    return Buffer.from(toEthereumSignature(digest, der, this.publicKey));
  }

  /** A signed, serialised transaction and its hash. The hash is known before anything is broadcast. */
  async signTransaction(tx: UnsignedTransaction): Promise<{ raw: string; hash: string }> {
    const digest = arrayify(keccak256(serialize(tx)));
    const der = await signDigestWithKms(this.kms, this.keyId, digest);
    const raw = serialize(tx, ethereumSignatureParts(digest, der, this.publicKey));
    return { raw, hash: keccak256(raw) };
  }
}

/** The same data-item signer with the key in process memory: local development and the ar.io sandbox only. */
export class PrivateKeyEthereumSigner {
  readonly ownerLength = 65;
  readonly signatureLength = 65;
  readonly signatureType = ETHEREUM_SIGNATURE_TYPE;
  readonly publicKey: Buffer;
  readonly address: string;
  private readonly key: SigningKey;

  constructor(privateKey: string) {
    this.key = new SigningKey(privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`);
    this.publicKey = Buffer.from(arrayify(this.key.publicKey));
    this.address = computeAddress(this.publicKey).toLowerCase();
  }

  async sign(message: Uint8Array): Promise<Uint8Array> {
    return Buffer.from(arrayify(joinSignature(this.key.signDigest(hashMessage(message)))));
  }
}
