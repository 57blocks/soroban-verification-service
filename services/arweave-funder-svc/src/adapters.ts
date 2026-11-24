import { PutObjectCommand } from "@aws-sdk/client-s3";
import { classifyConditionalWriteError, getObjectTextVersioned, type KmsEthereumSigner, type S3Client } from "@scvs/aws";
import { Uploader } from "@irys/upload";
import { BaseEth, EthereumToken } from "@irys/upload-ethereum";
import type { Chain, FunderState, Irys, StateStore } from "./funder.js";
import { STATE_SCHEMA } from "./funder.js";

const RPC_TIMEOUT_MS = 15_000;

/** The few Ethereum JSON-RPC calls a top-up needs, over plain fetch: no provider library holds state between rounds. */
export class JsonRpcChain implements Chain {
  private id = 0;

  constructor(private readonly url: string) {}

  private async call<T>(method: string, params: unknown[]): Promise<T> {
    const response = await fetch(this.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++this.id, method, params }),
      signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`${method}: RPC answered HTTP ${response.status}`);
    const body = (await response.json()) as { result?: T; error?: { code: number; message: string } };
    if (body.error) throw new RpcError(method, body.error.code, body.error.message);
    return body.result as T;
  }

  async chainId(): Promise<number> {
    return Number(BigInt(await this.call<string>("eth_chainId", [])));
  }

  async nonce(address: string, tag: "latest" | "pending"): Promise<number> {
    return Number(BigInt(await this.call<string>("eth_getTransactionCount", [address, tag])));
  }

  async balance(address: string): Promise<bigint> {
    return BigInt(await this.call<string>("eth_getBalance", [address, "latest"]));
  }

  async fees(): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }> {
    const [block, tip] = await Promise.all([
      this.call<{ baseFeePerGas?: string }>("eth_getBlockByNumber", ["latest", false]),
      this.call<string>("eth_maxPriorityFeePerGas", []),
    ]);
    if (!block.baseFeePerGas) throw new Error("the RPC's latest block has no baseFeePerGas; EIP-1559 is required");
    const maxPriorityFeePerGas = BigInt(tip);
    // Twice the base fee rides out six full blocks of base-fee increases before the transaction stalls.
    return { maxFeePerGas: BigInt(block.baseFeePerGas) * 2n + maxPriorityFeePerGas, maxPriorityFeePerGas };
  }

  async estimateGas(tx: { from: string; to: string; value: bigint }): Promise<bigint> {
    return BigInt(
      await this.call<string>("eth_estimateGas", [{ from: tx.from, to: tx.to, value: `0x${tx.value.toString(16)}` }]),
    );
  }

  async send(raw: string): Promise<void> {
    try {
      await this.call<string>("eth_sendRawTransaction", [raw]);
    } catch (error) {
      // Re-sending bytes the node already holds is the point of recording them first; that is not a failure.
      if (error instanceof RpcError && /already known|known transaction|already imported/i.test(error.message)) return;
      throw error;
    }
  }

  async receipt(hash: string): Promise<{ status: 0 | 1 } | undefined> {
    const receipt = await this.call<{ status: string } | null>("eth_getTransactionReceipt", [hash]);
    if (!receipt) return undefined;
    return { status: BigInt(receipt.status) === 1n ? 1 : 0 };
  }
}

export class RpcError extends Error {
  constructor(
    readonly method: string,
    readonly code: number,
    message: string,
  ) {
    super(`${method}: ${message} (${code})`);
    this.name = "RpcError";
  }
}

// Stands in for the wallet the token constructor demands; nothing reads it, because the token never builds a transaction.
const KMS_WALLET_PLACEHOLDER = "kms-signer-holds-no-private-key";
const TOKENS = { ethereum: EthereumToken, "base-eth": BaseEth as typeof EthereumToken } as const;
export type FunderToken = keyof typeof TOKENS;

function kmsToken(signer: KmsEthereumSigner, token: FunderToken): typeof EthereumToken {
  return class FunderKmsToken extends TOKENS[token] {
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
      throw new Error("the funder signs its own top-up transactions; it never lets the Irys SDK build one");
    }
  };
}

type IrysUploader = Awaited<ReturnType<ReturnType<typeof Uploader>["build"]>>;

export class IrysClient implements Irys {
  private constructor(private readonly uploader: IrysUploader) {}

  static async build(options: {
    signer: KmsEthereumSigner;
    token: FunderToken;
    network: "devnet" | "mainnet";
    rpcUrl: string;
  }): Promise<IrysClient> {
    let builder = Uploader(kmsToken(options.signer, options.token)).withWallet(KMS_WALLET_PLACEHOLDER).withRpc(options.rpcUrl);
    builder = options.network === "mainnet" ? builder.mainnet() : builder.devnet();
    const uploader = await builder;
    if (uploader.address !== options.signer.address) {
      throw new Error(`Irys resolved address ${uploader.address}, not the funding key's ${options.signer.address}`);
    }
    return new IrysClient(uploader);
  }

  async depositAddress(): Promise<string> {
    return this.uploader.utils.getBundlerAddress(this.uploader.token);
  }

  async balance(address: string): Promise<bigint> {
    return BigInt((await this.uploader.getBalance(address)).toFixed(0));
  }

  async approval(approvedAddress: string): Promise<{ amount: bigint; expiresAt?: number }> {
    const approval = (await this.uploader.approval.getApproval({ approvedAddress })) as { amount: string; expiresBy?: string };
    const expiresAt = approval.expiresBy ? Math.floor(Date.parse(approval.expiresBy) / 1000) : undefined;
    return { amount: BigInt(approval.amount), ...(expiresAt !== undefined && Number.isFinite(expiresAt) ? { expiresAt } : {}) };
  }

  async createApproval(approvedAddress: string, amount: bigint, expiresInSeconds: number): Promise<string> {
    const receipt = await this.uploader.approval.createApproval({ approvedAddress, amount: amount.toString(), expiresInSeconds });
    return receipt.id;
  }

  async submitFundTransaction(hash: string): Promise<"credited" | "pending"> {
    const response = await this.uploader.funder.submitFundTransaction(hash);
    return response.status === 200 ? "credited" : "pending";
  }
}

/** The funder's whole state as one S3 object, written only with a precondition on the version it read. */
export class S3StateStore implements StateStore {
  constructor(
    private readonly s3: S3Client,
    private readonly bucket: string,
    private readonly key: string,
  ) {}

  async load(): Promise<{ state: FunderState | undefined; version: string | null }> {
    const object = await getObjectTextVersioned(this.s3, this.bucket, this.key);
    if (!object) return { state: undefined, version: null };
    const state = JSON.parse(object.text) as FunderState;
    if (state.schema !== STATE_SCHEMA) throw new Error(`state ${this.bucket}/${this.key} has schema ${state.schema}, expected ${STATE_SCHEMA}`);
    return { state, version: object.version };
  }

  async save(state: FunderState, version: string | null): Promise<string | false> {
    try {
      const response = await this.s3.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: this.key,
          Body: `${JSON.stringify(state, null, 2)}\n`,
          ContentType: "application/json",
          ...(version === null ? { IfNoneMatch: "*" } : { IfMatch: version }),
        }),
      );
      if (!response.ETag) throw new Error(`PutObject ${this.bucket}/${this.key} returned no ETag`);
      return response.ETag;
    } catch (error) {
      if (classifyConditionalWriteError(error, version === null ? "if-none-match" : "if-match") === "fatal") throw error;
      return false;
    }
  }
}
