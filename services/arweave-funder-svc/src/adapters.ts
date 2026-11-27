import { PutObjectCommand } from "@aws-sdk/client-s3";
import {
  classifyConditionalWriteError,
  getObjectTextVersioned,
  type KmsEthereumSigner,
  type S3Client,
  type TurboClient,
  type TurboShare,
  TurboHttpError,
  type TurboToken,
} from "@scvs/aws";
import type { Bundler, Chain, FunderState, Receipt, StateStore } from "./funder.js";
import { ShareRefused, STATE_SCHEMA } from "./funder.js";

const RPC_TIMEOUT_MS = 15_000;
const GAS_PRICE_ORACLE = "0x420000000000000000000000000000000000000F";
const GET_L1_FEE_UPPER_BOUND = "0xf1c7a58b";

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
      // Re-sending bytes the node already holds is the point of recording them first; that is not a failure. A spent
      // nonce is not one either: the round's receipt and nonce checks decide whose transaction used it.
      if (error instanceof RpcError && /already known|known transaction|already imported|nonce too low/i.test(error.message)) return;
      throw error;
    }
  }

  async receipt(hash: string): Promise<Receipt | undefined> {
    const receipt = await this.call<{ status: string; blockNumber: string; gasUsed: string; effectiveGasPrice: string; l1Fee?: string } | null>(
      "eth_getTransactionReceipt",
      [hash],
    );
    if (!receipt) return undefined;
    return {
      status: BigInt(receipt.status) === 1n ? 1 : 0,
      blockNumber: Number(BigInt(receipt.blockNumber)),
      feeWei: BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice) + BigInt(receipt.l1Fee ?? "0x0"),
    };
  }

  async safeBlock(): Promise<number> {
    const block = await this.call<{ number: string } | null>("eth_getBlockByNumber", ["safe", false]);
    if (!block) throw new Error("the RPC has no safe block");
    return Number(BigInt(block.number));
  }

  async l1FeeUpperBound(txBytes: number): Promise<bigint> {
    const data = `${GET_L1_FEE_UPPER_BOUND}${txBytes.toString(16).padStart(64, "0")}`;
    return BigInt(await this.call<string>("eth_call", [{ to: GAS_PRICE_ORACLE, data }, "latest"]));
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

export type FunderToken = TurboToken;

type GivenShare = Pick<TurboShare, "approvedAddress" | "approvedWincAmount" | "usedWincAmount" | "expirationDate">;

export function remainingShare(shares: GivenShare[], approvedAddress: string, nowMs: number): { amount: bigint; expiresAt?: number } {
  let amount = 0n;
  let expiresAt: number | undefined;
  for (const share of shares) {
    if (share.approvedAddress.toLowerCase() !== approvedAddress.toLowerCase()) continue;
    const expiry = share.expirationDate ? Date.parse(share.expirationDate) : undefined;
    if (expiry !== undefined && expiry <= nowMs) continue;
    amount += BigInt(share.approvedWincAmount) - BigInt(share.usedWincAmount);
    if (expiry !== undefined) expiresAt = Math.max(expiresAt ?? 0, Math.floor(expiry / 1000));
  }
  return { amount, ...(expiresAt !== undefined ? { expiresAt } : {}) };
}

/** The funding key's side of Turbo: it buys credits, shares them, and signs each share as a data item. */
export class TurboFunderClient implements Bundler {
  constructor(
    private readonly turbo: TurboClient,
    private readonly signer: KmsEthereumSigner,
  ) {}

  depositAddress(): Promise<string> {
    return this.turbo.depositAddress();
  }

  balance(address: string): Promise<bigint> {
    return this.turbo.balance(address);
  }

  async shared(approvedAddress: string): Promise<{ amount: bigint; expiresAt?: number }> {
    return remainingShare(await this.turbo.sharesGivenBy(this.signer.address), approvedAddress, Date.now());
  }

  async shareCredits(approvedAddress: string, amount: bigint, expiresInSeconds: number): Promise<string> {
    try {
      return await this.turbo.shareCredits(this.signer, approvedAddress, amount, expiresInSeconds);
    } catch (error) {
      // A 4xx is Turbo turning the share down; a 5xx or a lost answer may come after the share was made.
      if (error instanceof TurboHttpError && error.status >= 400 && error.status < 500) throw new ShareRefused(error.message);
      throw error;
    }
  }

  submitFundTransaction(hash: string): Promise<"credited" | "pending" | "rejected"> {
    return this.turbo.submitFundTransaction(hash);
  }
}

/**
 * Schema 1 paid Irys. Its approvals are Irys amounts in wei and are dropped. Its transfers went to Irys's deposit
 * address, so Turbo will never credit them: a mined one is settled as refused, and one still in flight stops the load,
 * because which of the two services it pays cannot be decided here.
 */
function fromIrysState(parsed: Omit<FunderState, "schema">, bucket: string, key: string): FunderState {
  const inFlight = parsed.txs.find((tx) => tx.status === "signed" || tx.status === "broadcast");
  if (inFlight) {
    throw new Error(
      `state ${bucket}/${key} is an Irys-era state with top-up ${inFlight.hash} (nonce ${inFlight.nonce}) still ${inFlight.status}; settle it by hand before this funder runs`,
    );
  }
  const migratedAt = Math.floor(Date.now() / 1000);
  return {
    ...parsed,
    schema: STATE_SCHEMA,
    approvals: [],
    txs: parsed.txs.map((tx) => (tx.status === "mined" ? { ...tx, status: "rejected", confirmedAt: migratedAt } : tx)),
  };
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
    const parsed = JSON.parse(object.text) as Omit<FunderState, "schema"> & { schema: number };
    const state: FunderState = parsed.schema === 1 ? fromIrysState(parsed, this.bucket, this.key) : (parsed as FunderState);
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
