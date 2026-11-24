import { GetPublicKeyCommand, KMSClient, SignCommand } from "@aws-sdk/client-kms";

export function createKmsClient(region?: string): KMSClient {
  return new KMSClient({ region: region || "us-east-1" });
}

export type KmsSendClient = Pick<KMSClient, "send">;

/** The region a key ARN or alias ARN names; undefined for a bare key id or alias name. */
export function kmsKeyRegion(keyId: string): string | undefined {
  return /^arn:aws[a-z-]*:kms:([a-z0-9-]+):\d{12}:(?:key|alias)\//.exec(keyId)?.[1];
}

// DER SubjectPublicKeyInfo header for an uncompressed secp256k1 point: id-ecPublicKey, secp256k1, BIT STRING(66).
const SECP256K1_SPKI_PREFIX = Buffer.from("3056301006072a8648ce3d020106052b8104000a034200", "hex");

/** The key's 65-byte uncompressed public point (0x04 ‖ X ‖ Y); throws unless it is a secp256k1 signing key. */
export async function getSecp256k1PublicKey(client: KmsSendClient, keyId: string): Promise<Uint8Array> {
  const response = await client.send(new GetPublicKeyCommand({ KeyId: keyId }));
  if (response.KeySpec !== "ECC_SECG_P256K1" || response.KeyUsage !== "SIGN_VERIFY") {
    throw new Error(
      `KMS key ${keyId} is ${response.KeySpec ?? "unknown"}/${response.KeyUsage ?? "unknown"}; an Ethereum signer needs ECC_SECG_P256K1/SIGN_VERIFY`,
    );
  }
  const spki = Buffer.from(response.PublicKey ?? new Uint8Array());
  if (
    spki.length !== SECP256K1_SPKI_PREFIX.length + 65 ||
    !spki.subarray(0, SECP256K1_SPKI_PREFIX.length).equals(SECP256K1_SPKI_PREFIX) ||
    spki[SECP256K1_SPKI_PREFIX.length] !== 0x04
  ) {
    throw new Error(`KMS key ${keyId} returned a public key that is not an uncompressed secp256k1 point`);
  }
  return new Uint8Array(spki.subarray(SECP256K1_SPKI_PREFIX.length));
}

/** Signs a precomputed 32-byte digest as-is (KMS does not hash it again); returns the DER-encoded ECDSA signature. */
export async function signDigestWithKms(client: KmsSendClient, keyId: string, digest: Uint8Array): Promise<Uint8Array> {
  if (digest.length !== 32) throw new Error(`a KMS digest signature needs a 32-byte digest, got ${digest.length}`);
  const response = await client.send(
    new SignCommand({ KeyId: keyId, Message: digest, MessageType: "DIGEST", SigningAlgorithm: "ECDSA_SHA_256" }),
  );
  if (!response.Signature) throw new Error(`KMS returned no signature for key ${keyId}`);
  return response.Signature;
}
