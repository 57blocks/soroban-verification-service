import { KmsEthereumSigner } from "@scvs/aws";
import { BaseEth, EthereumToken } from "@irys/upload-ethereum";

export { KmsEthereumSigner, parseDerSignature, toEthereumSignature } from "@scvs/aws";

// Stands in for the wallet the token constructor demands; only the funding path reads it, and that path is closed.
export const KMS_WALLET_PLACEHOLDER = "kms-signer-holds-no-private-key";

/** The Irys tokens this service can pay in. An approval is per token, so the uploader must use the payer's. */
export const ARWEAVE_TOKENS = {
  ethereum: EthereumToken,
  "base-eth": BaseEth as typeof EthereumToken,
} as const;
export type ArweaveToken = keyof typeof ARWEAVE_TOKENS;

/** The Irys token class for `token`, signing through `signer` instead of a private key held in process memory. */
export function kmsIrysToken(signer: KmsEthereumSigner, token: ArweaveToken = "ethereum"): typeof EthereumToken {
  const Base = ARWEAVE_TOKENS[token];
  return class KmsIrysToken extends Base {
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
      throw new Error("the KMS-signed archiving wallet never funds itself; uploads are paid through another wallet's approval");
    }
  };
}
