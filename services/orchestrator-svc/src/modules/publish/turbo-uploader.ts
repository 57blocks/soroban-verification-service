import { PrivateKeyEthereumSigner, TurboClient, type DataItemSigner, type DataItemTag, type TurboUploadResult } from "@scvs/aws";
import type { ArweaveToken, TurboEndpoints } from "@scvs/config";
import type { KmsEthereumSigner } from "./kms-ethereum-signer.js";

/** The one thing the archive needs from a bundler: sign the bytes as a data item and store them, billed to `paidBy`. */
export interface ArchiveUploader {
  readonly address: string;
  /** base64url of the data-item owner bytes, as gateways report `owner.key`. */
  readonly ownerKey: string;
  upload(data: Buffer, tags: DataItemTag[], paidBy?: string): Promise<TurboUploadResult>;
}

export class TurboArchiveUploader implements ArchiveUploader {
  constructor(
    private readonly turbo: Pick<TurboClient, "upload">,
    private readonly signer: DataItemSigner & { readonly address: string },
  ) {}

  get address(): string {
    return this.signer.address;
  }

  get ownerKey(): string {
    return Buffer.from(this.signer.publicKey).toString("base64url");
  }

  upload(data: Buffer, tags: DataItemTag[], paidBy?: string): Promise<TurboUploadResult> {
    return this.turbo.upload(data, tags, this.signer, paidBy);
  }
}

export function buildTurboUploader(options: {
  signer: { kms: KmsEthereumSigner } | { privateKey: string | undefined };
  token: ArweaveToken;
  endpoints: TurboEndpoints;
}): TurboArchiveUploader {
  let signer: DataItemSigner & { readonly address: string };
  if ("kms" in options.signer) {
    signer = options.signer.kms;
  } else {
    if (!options.signer.privateKey) throw new Error("SCVS_ARWEAVE_WALLET_PRIVATE_KEY is required when SCVS_ARWEAVE_SIGNER is private-key");
    signer = new PrivateKeyEthereumSigner(options.signer.privateKey);
  }
  return new TurboArchiveUploader(new TurboClient(options.endpoints, options.token), signer);
}
