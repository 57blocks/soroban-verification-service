import { createHash } from "node:crypto";

export type DataItemTag = { name: string; value: string };

/** What signs an ANS-104 data item: the KMS Ethereum signer satisfies it as signature type 3. */
export interface DataItemSigner {
  readonly signatureType: number;
  readonly signatureLength: number;
  readonly ownerLength: number;
  readonly publicKey: Uint8Array;
  sign(message: Uint8Array): Promise<Uint8Array>;
}

export type SignedDataItem = { id: string; raw: Buffer };

const MAX_TAGS = 128;
const MAX_TAG_BYTES = 4096;

type DeepHashChunk = Uint8Array | DeepHashChunk[];

const sha384 = (...parts: Uint8Array[]): Buffer => createHash("sha384").update(Buffer.concat(parts)).digest();

/** Arweave's deep hash: each blob and list is hashed under a tag naming its kind and length. */
export function deepHash(chunk: DeepHashChunk): Buffer {
  if (Array.isArray(chunk)) {
    let acc = sha384(Buffer.from(`list${chunk.length}`));
    for (const child of chunk) acc = sha384(acc, deepHash(child));
    return acc;
  }
  return sha384(sha384(Buffer.from(`blob${chunk.byteLength}`)), sha384(chunk));
}

// Avro long: zig-zag, then little-endian base-128 groups.
function avroLong(n: number): Buffer {
  const bytes: number[] = [];
  let m = BigInt(n) << 1n;
  do {
    let byte = Number(m & 0x7fn);
    m >>= 7n;
    if (m > 0n) byte |= 0x80;
    bytes.push(byte);
  } while (m > 0n);
  return Buffer.from(bytes);
}

const avroString = (s: string): Buffer => {
  const bytes = Buffer.from(s, "utf8");
  return Buffer.concat([avroLong(bytes.byteLength), bytes]);
};

/** Tags as an Avro array of {name, value} records; no tags is zero bytes, not an empty array. */
export function serializeTags(tags: DataItemTag[]): Buffer {
  if (tags.length === 0) return Buffer.alloc(0);
  if (tags.length > MAX_TAGS) throw new Error(`a data item carries at most ${MAX_TAGS} tags, not ${tags.length}`);
  const encoded = Buffer.concat([avroLong(tags.length), ...tags.flatMap((t) => [avroString(t.name), avroString(t.value)]), avroLong(0)]);
  if (encoded.byteLength > MAX_TAG_BYTES) throw new Error(`a data item's tags take at most ${MAX_TAG_BYTES} bytes, not ${encoded.byteLength}`);
  return encoded;
}

const u64le = (n: number): Buffer => {
  const out = Buffer.alloc(8);
  out.writeBigUInt64LE(BigInt(n));
  return out;
};

const u16le = (n: number): Buffer => {
  const out = Buffer.alloc(2);
  out.writeUInt16LE(n);
  return out;
};

/** A signed ANS-104 data item with no target and no anchor; its id is base64url(sha256(signature)). */
export async function createSignedDataItem(data: Uint8Array, tags: DataItemTag[], signer: DataItemSigner): Promise<SignedDataItem> {
  const owner = Buffer.from(signer.publicKey);
  if (owner.byteLength !== signer.ownerLength) throw new Error(`owner must be ${signer.ownerLength} bytes, not ${owner.byteLength}`);
  const rawTags = serializeTags(tags);
  const message = deepHash([
    Buffer.from("dataitem"),
    Buffer.from("1"),
    Buffer.from(String(signer.signatureType)),
    owner,
    Buffer.alloc(0),
    Buffer.alloc(0),
    rawTags,
    Buffer.from(data),
  ]);
  const signature = Buffer.from(await signer.sign(message));
  if (signature.byteLength !== signer.signatureLength) {
    throw new Error(`signature must be ${signer.signatureLength} bytes, not ${signature.byteLength}`);
  }
  const raw = Buffer.concat([
    u16le(signer.signatureType),
    signature,
    owner,
    Buffer.from([0]),
    Buffer.from([0]),
    u64le(tags.length),
    u64le(rawTags.byteLength),
    rawTags,
    Buffer.from(data),
  ]);
  return { id: createHash("sha256").update(signature).digest("base64url"), raw };
}
