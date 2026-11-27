import assert from "node:assert/strict";
import { test } from "node:test";
import { SigningKey } from "@ethersproject/signing-key";
import { createSignedDataItem, deepHash, serializeTags, type DataItemTag } from "./ans104.js";
import { KmsEthereumSigner } from "./kms-ethereum.js";
import type { KmsSendClient } from "./kms.js";

// Produced by the reference implementation (@dha-team/arbundles createData + EthereumSigner) for this key.
const PRIVATE_KEY = "0x1111111111111111111111111111111111111111111111111111111111111111";
const VECTORS: { name: string; tags: DataItemTag[]; dataHex: string; signatureDataHex: string; rawHex: string; id: string }[] = [
  {
    "name": "tags",
    "tags": [
      {
        "name": "Content-Type",
        "value": "application/json"
      },
      {
        "name": "App-Name",
        "value": "Stellar-Verifier"
      },
      {
        "name": "Report_Hash",
        "value": "abababababababababababababababababababababababababababababababab"
      }
    ],
    "dataHex": "7b226d617463686564223a747275657d",
    "signatureDataHex": "be2964296fe1d6b84b1e2e88673898d3c74fd15ab012fb262ab1f5b1d91e8d892b8c8efa776577bd589121c98957ec76",
    "rawHex": "0300681e2fa74907752b66fb36a427239eab5db5622e89626723dd2fd99afd58717231a36e047473212fe20b874c224a86db648867828dfff343eb400e2e9a401ffa1c044f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa385b6b1b8ead809ca67454d9683fcf2ba03456d6fe2c4abe2b07f0fbdbb2f1c10000030000000000000088000000000000000618436f6e74656e742d54797065206170706c69636174696f6e2f6a736f6e104170702d4e616d65205374656c6c61722d5665726966696572165265706f72745f48617368800161626162616261626162616261626162616261626162616261626162616261626162616261626162616261626162616261626162616261626162616261626162007b226d617463686564223a747275657d",
    "id": "TtcCVVWD0lhrui6nhAAXNQ66KxkuiO37bsHYJDWO450"
  },
  {
    "name": "no-tags",
    "tags": [],
    "dataHex": "706c61696e",
    "signatureDataHex": "42a598aa1b7bda06871b4988fb17dc89661474219d4df4ce554ffcb59d232ecc821581d27223b2c94140dd92d8239473",
    "rawHex": "030097f550ac0d5dbb8d91a5d344e4e95fc3184c8233b88a6b0557dd323522711cfe75c90f4ee665421c7a8b420914912c852cd97081226392682d8960706ab6e8741c044f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa385b6b1b8ead809ca67454d9683fcf2ba03456d6fe2c4abe2b07f0fbdbb2f1c1000000000000000000000000000000000000706c61696e",
    "id": "d10clwFzVGv_9eqygSI6Zrnmh7raeVLHTOl9gYMFGfM"
  },
  {
    "name": "long-tag",
    "tags": [
      {
        "name": "X",
        "value": "vvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvv"
      }
    ],
    "dataHex": "070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707",
    "signatureDataHex": "6812ceaa42f1ebd650a32b06b0bfc7b7d706e2ff92729e9775903e5bc773368a960e0840a6878d64338218593bbf7da1",
    "rawHex": "0300fbf4e49cee73363a735bfc9ed92fdf052a3ab92f2e09fe7aa5b8d273928a1264672b1e493b21d43d8e75bab9dbc4a648d978f6547777244e83affb33fdaa04081b044f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa385b6b1b8ead809ca67454d9683fcf2ba03456d6fe2c4abe2b07f0fbdbb2f1c100000100000000000000ce000000000000000202589003767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767676767600070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707",
    "id": "qTLu2ON3_lH5aW9BeeGKejcV01EU-Y4G9AWxUC6_M9E"
  }
];

const SPKI_PREFIX = "3056301006072a8648ce3d020106052b8104000a034200";

function derInteger(hex: string): Buffer {
  let bytes = Buffer.from(hex.replace(/^0x/, ""), "hex");
  while (bytes.length > 1 && bytes[0] === 0 && (bytes[1]! & 0x80) === 0) bytes = bytes.subarray(1);
  if (bytes[0]! & 0x80) bytes = Buffer.concat([Buffer.from([0]), bytes]);
  return Buffer.concat([Buffer.from([0x02, bytes.length]), bytes]);
}

// RFC 6979 signatures from a local key stand in for KMS, so the bytes are as reproducible as the reference's.
function localKms(): KmsSendClient {
  const key = new SigningKey(PRIVATE_KEY);
  return {
    async send(command: { constructor: { name: string }; input: { Message?: Uint8Array } }) {
      if (command.constructor.name === "GetPublicKeyCommand") {
        return { KeySpec: "ECC_SECG_P256K1", KeyUsage: "SIGN_VERIFY", PublicKey: Buffer.from(SPKI_PREFIX + key.publicKey.slice(2), "hex") };
      }
      const sig = key.signDigest(command.input.Message!);
      const body = Buffer.concat([derInteger(sig.r), derInteger(sig.s)]);
      return { Signature: Buffer.concat([Buffer.from([0x30, body.length]), body]) };
    },
  } as unknown as KmsSendClient;
}

for (const vector of VECTORS) {
  test(`a data item signed through KMS matches the reference byte for byte (${vector.name})`, async () => {
    const signer = await KmsEthereumSigner.create(localKms(), "arn:aws:kms:ap-southeast-2:000000000000:key/test");
    const item = await createSignedDataItem(Buffer.from(vector.dataHex, "hex"), vector.tags, signer);
    assert.equal(item.raw.toString("hex"), vector.rawHex);
    assert.equal(item.id, vector.id);
  });
}

test("the deep hash a data item signs matches the reference", () => {
  const vector = VECTORS[0]!;
  const raw = Buffer.from(vector.rawHex, "hex");
  const owner = raw.subarray(67, 132);
  const tags = serializeTags(vector.tags);
  const message = deepHash([Buffer.from("dataitem"), Buffer.from("1"), Buffer.from("3"), owner, Buffer.alloc(0), Buffer.alloc(0), tags, Buffer.from(vector.dataHex, "hex")]);
  assert.equal(message.toString("hex"), vector.signatureDataHex);
});

test("tags past the size limit are refused rather than truncated", () => {
  assert.throws(() => serializeTags([{ name: "X", value: "v".repeat(5000) }]), /at most 4096 bytes/);
});
