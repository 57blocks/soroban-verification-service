import type { UnsignedTransaction } from "@ethersproject/transactions";

/**
 * One round of the Arweave funder: keeps the funding key's Irys balance topped up from the ETH sent to its
 * address, and keeps a bounded, short-lived Irys approval in place for the upload key.
 *
 * What this code limits (recipient, per-top-up amount, daily total, fee cap, approval window) guards against
 * our own bugs only. Whoever holds this task role can call kms:Sign directly and skip all of it. The real
 * bounds are the key policy and how much ETH sits at the funding address; what this round adds against a
 * compromise is detection — every outgoing nonce must be one it recorded, or it halts and says so.
 */

export const STATE_SCHEMA = 1;
const DAY_SECONDS = 86_400;
const APPROVAL_HISTORY_SECONDS = 30 * DAY_SECONDS;
const SETTLED_HISTORY_SECONDS = 30 * DAY_SECONDS;
const RECEIPT_GRACE_SECONDS = 180;

export type TxStatus = "signed" | "broadcast" | "mined" | "credited" | "failed" | "dropped";

export type FundTx = {
  nonce: number;
  hash: string;
  raw: string;
  value: string;
  maxFeePerGas: string;
  maxPriorityFeePerGas: string;
  status: TxStatus;
  createdAt: number;
  updatedAt: number;
};

export type FunderState = {
  schema: typeof STATE_SCHEMA;
  /** The next nonce this funder will use. The chain's nonce must never pass it. */
  nextNonce: number;
  lease?: { holder: string; until: number };
  halted?: { reason: string; at: number };
  txs: FundTx[];
  approvals: { at: number; amount: string }[];
};

export interface Chain {
  chainId(): Promise<number>;
  nonce(address: string, tag: "latest" | "pending"): Promise<number>;
  balance(address: string): Promise<bigint>;
  fees(): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }>;
  estimateGas(tx: { from: string; to: string; value: bigint }): Promise<bigint>;
  /** Resolves once the node accepted the transaction, or already knows it. */
  send(raw: string): Promise<void>;
  receipt(hash: string): Promise<{ status: 0 | 1 } | undefined>;
}

export interface Irys {
  depositAddress(): Promise<string>;
  balance(address: string): Promise<bigint>;
  approval(approvedAddress: string): Promise<{ amount: bigint; expiresAt?: number }>;
  createApproval(approvedAddress: string, amount: bigint, expiresInSeconds: number): Promise<string>;
  /** `credited` once Irys has added the deposit to the sender's balance; `pending` while it waits for confirmations. */
  submitFundTransaction(hash: string): Promise<"credited" | "pending">;
}

export interface StateStore {
  load(): Promise<{ state: FunderState | undefined; version: string | null }>;
  /** `false` when someone else wrote first. */
  save(state: FunderState, version: string | null): Promise<string | false>;
}

export interface TxSigner {
  readonly address: string;
  signTransaction(tx: UnsignedTransaction): Promise<{ raw: string; hash: string }>;
}

export interface Telemetry {
  gauge(name: string, value: number): void;
  event(level: "info" | "warn" | "error", msg: string, fields?: Record<string, unknown>): void;
}

export type FunderSettings = {
  chainId: number;
  depositAddress: string;
  approvedAddress: string;
  irysLowWei: bigint;
  topUpWei: bigint;
  dailyTopUpCapWei: bigint;
  maxFeePerGasWei: bigint;
  maxGasLimit: bigint;
  stuckAfterSeconds: number;
  approvalWei: bigint;
  approvalTtlSeconds: number;
  approvalRenewBeforeSeconds: number;
  /** Approvals created within any approvalTtlSeconds window may not sum past this: the most a stolen upload key can spend in one window. */
  approvalWindowCapWei: bigint;
  leaseSeconds: number;
  holder: string;
};

export type RoundOutcome = "lease-held" | "conflict" | "halted" | "done";

class Conflict extends Error {}

const WEI_PER_ETH = 10n ** 18n;
const toEth = (wei: bigint): number => Number(wei) / Number(WEI_PER_ETH);
const lower = (address: string): string => address.toLowerCase();

export class FunderRound {
  private state!: FunderState;
  private version: string | null = null;

  constructor(
    private readonly settings: FunderSettings,
    private readonly deps: {
      chain: Chain;
      irys: Irys;
      store: StateStore;
      signer: TxSigner;
      telemetry: Telemetry;
      now: () => number;
    },
  ) {}

  async run(): Promise<RoundOutcome> {
    try {
      return await this.runInner();
    } catch (error) {
      if (error instanceof Conflict) return "conflict";
      throw error;
    }
  }

  private async runInner(): Promise<RoundOutcome> {
    const { chain, store, signer, telemetry } = this.deps;
    const now = this.now();
    const loaded = await store.load();
    this.version = loaded.version;

    const latest = await chain.nonce(signer.address, "latest");
    if (!loaded.state) {
      this.state = { schema: STATE_SCHEMA, nextNonce: latest, txs: [], approvals: [] };
      telemetry.event(latest === 0 ? "info" : "warn", "arweave funder: no state yet; starting from the chain's nonce", {
        nonce: latest,
        address: signer.address,
      });
    } else {
      this.state = loaded.state;
    }

    const lease = this.state.lease;
    if (lease && lease.holder !== this.settings.holder && lease.until > now) return "lease-held";
    this.state.lease = { holder: this.settings.holder, until: now + this.settings.leaseSeconds };
    await this.save();

    if (this.state.halted) {
      telemetry.gauge("arweave_funder_halted", 1);
      telemetry.event("error", "arweave funder is halted; clear `halted` in its state object once the cause is understood", this.state.halted);
      await this.reportBalances();
      return "halted";
    }
    telemetry.gauge("arweave_funder_halted", 0);

    const chainId = await chain.chainId();
    if (chainId !== this.settings.chainId) {
      throw new Error(`RPC reports chain ${chainId}, configured for ${this.settings.chainId}; refusing to sign for the wrong chain`);
    }

    if (latest > this.state.nextNonce) {
      return this.halt(`unexpected outflow: the funding address has sent ${latest} transactions, this funder accounts for ${this.state.nextNonce}`);
    }

    if ((await this.reconcileInFlight(latest)) === "halted") return "halted";
    await this.creditMined();
    if ((await this.maybeTopUp(latest)) === "halted") return "halted";
    await this.maybeRenewApproval();
    this.prune();
    await this.save();
    await this.reportBalances();
    return "done";
  }

  private now(): number {
    return Math.floor(this.deps.now() / 1000);
  }

  private async save(): Promise<void> {
    const version = await this.deps.store.save(this.state, this.version);
    if (version === false) throw new Conflict();
    this.version = version;
  }

  private async halt(reason: string): Promise<"halted"> {
    this.state.halted = { reason, at: this.now() };
    this.deps.telemetry.gauge("arweave_funder_halted", 1);
    this.deps.telemetry.event("error", `arweave funder halted: ${reason}`);
    await this.save();
    return "halted";
  }

  private groups(): Map<number, FundTx[]> {
    const byNonce = new Map<number, FundTx[]>();
    for (const tx of this.state.txs) byNonce.set(tx.nonce, [...(byNonce.get(tx.nonce) ?? []), tx]);
    return byNonce;
  }

  private static settled(group: FundTx[]): boolean {
    return group.some((tx) => tx.status === "mined" || tx.status === "credited" || tx.status === "failed");
  }

  private async reconcileInFlight(latest: number): Promise<"halted" | "ok"> {
    const { chain, telemetry } = this.deps;
    for (const [nonce, group] of this.groups()) {
      if (FunderRound.settled(group)) continue;
      const live = group.filter((tx) => tx.status === "signed" || tx.status === "broadcast");
      for (const tx of live) {
        if (tx.status === "signed") {
          await chain.send(tx.raw);
          this.mark(tx, "broadcast");
          await this.save();
        }
      }
      let landed: { tx: FundTx; status: 0 | 1 } | undefined;
      for (const tx of live) {
        const receipt = await chain.receipt(tx.hash);
        if (receipt) landed = { tx, status: receipt.status };
      }
      if (landed) {
        for (const tx of live) this.mark(tx, tx === landed.tx ? (landed.status === 1 ? "mined" : "failed") : "dropped");
        if (landed.status === 0) telemetry.event("error", "arweave funder: top-up transaction reverted", { hash: landed.tx.hash, nonce });
        await this.save();
        continue;
      }
      const newest = live.reduce((a, b) => (a.createdAt >= b.createdAt ? a : b));
      if (latest > nonce) {
        // A receipt can trail the nonce on a load-balanced RPC; only a gap that outlasts that is someone else's transaction.
        if (this.now() - newest.updatedAt < RECEIPT_GRACE_SECONDS) continue;
        return this.halt(`nonce ${nonce} was consumed by a transaction this funder did not record`);
      }
      if (this.now() - newest.createdAt < this.settings.stuckAfterSeconds) continue;
      await this.replace(newest);
    }
    return "ok";
  }

  /** Same nonce, same recipient and value, fees raised by at least the 12.5% a node requires to accept a replacement. */
  private async replace(stuck: FundTx): Promise<void> {
    const bump = (wei: string): bigint => (BigInt(wei) * 1125n) / 1000n + 1n;
    const current = await this.deps.chain.fees();
    const maxPriorityFeePerGas = [bump(stuck.maxPriorityFeePerGas), current.maxPriorityFeePerGas].reduce((a, b) => (a > b ? a : b));
    const maxFeePerGas = [bump(stuck.maxFeePerGas), current.maxFeePerGas, maxPriorityFeePerGas].reduce((a, b) => (a > b ? a : b));
    if (maxFeePerGas > this.settings.maxFeePerGasWei) {
      this.deps.telemetry.gauge("arweave_funder_fee_cap_reached", 1);
      this.deps.telemetry.event("warn", "arweave funder: a stuck top-up needs a fee above the cap; leaving it", {
        hash: stuck.hash,
        needed_max_fee_per_gas: maxFeePerGas.toString(),
      });
      return;
    }
    await this.signAndSend(stuck.nonce, BigInt(stuck.value), maxFeePerGas, maxPriorityFeePerGas);
  }

  private async creditMined(): Promise<void> {
    for (const tx of this.state.txs) {
      if (tx.status !== "mined") continue;
      const result = await this.deps.irys.submitFundTransaction(tx.hash);
      if (result === "credited") {
        this.mark(tx, "credited");
        await this.save();
      }
    }
  }

  private toppedUpWithin(seconds: number): bigint {
    const since = this.now() - seconds;
    let total = 0n;
    for (const group of this.groups().values()) {
      const counted = group.find((tx) => tx.status !== "dropped" && tx.status !== "failed");
      if (counted && group[0]!.createdAt >= since) total += BigInt(counted.value);
    }
    return total;
  }

  private async maybeTopUp(latest: number): Promise<"halted" | "ok"> {
    const { chain, irys, signer, telemetry } = this.deps;
    const s = this.settings;
    const inFlight = this.state.txs.some((tx) => tx.status === "signed" || tx.status === "broadcast" || tx.status === "mined");
    if (inFlight) return "ok";

    const irysBalance = await irys.balance(signer.address);
    if (irysBalance >= s.irysLowWei) return "ok";

    const toppedUp = this.toppedUpWithin(DAY_SECONDS);
    if (toppedUp + s.topUpWei > s.dailyTopUpCapWei) {
      telemetry.gauge("arweave_funder_daily_cap_reached", 1);
      telemetry.event("warn", "arweave funder: Irys balance is low but today's top-ups have reached the daily cap", {
        topped_up_wei: toppedUp.toString(),
      });
      return "ok";
    }
    telemetry.gauge("arweave_funder_daily_cap_reached", 0);

    const reported = lower(await irys.depositAddress());
    if (reported !== lower(s.depositAddress)) {
      return this.halt(`Irys reports deposit address ${reported}, configured ${lower(s.depositAddress)}`);
    }

    const fees = await chain.fees();
    if (fees.maxFeePerGas > s.maxFeePerGasWei) {
      telemetry.gauge("arweave_funder_fee_cap_reached", 1);
      telemetry.event("warn", "arweave funder: network fees are above the cap; not topping up this round", {
        max_fee_per_gas: fees.maxFeePerGas.toString(),
      });
      return "ok";
    }
    telemetry.gauge("arweave_funder_fee_cap_reached", 0);

    const gasLimit = await chain.estimateGas({ from: signer.address, to: s.depositAddress, value: s.topUpWei });
    if (gasLimit > s.maxGasLimit) throw new Error(`a top-up would need ${gasLimit} gas, above the ${s.maxGasLimit} limit`);
    const onChain = await chain.balance(signer.address);
    if (onChain < s.topUpWei + gasLimit * fees.maxFeePerGas) {
      telemetry.event("warn", "arweave funder: Irys balance is low and the funding address holds too little ETH to top it up", {
        address: signer.address,
        balance_wei: onChain.toString(),
      });
      return "ok";
    }
    if (latest !== this.state.nextNonce) throw new Error(`nonce ${latest} is not the accounted ${this.state.nextNonce} with nothing in flight`);
    await this.signAndSend(this.state.nextNonce, s.topUpWei, fees.maxFeePerGas, fees.maxPriorityFeePerGas, gasLimit);
    return "ok";
  }

  /** Records the signed transaction before broadcasting it, so a crash in between re-sends the same bytes rather than signing anew. */
  private async signAndSend(
    nonce: number,
    value: bigint,
    maxFeePerGas: bigint,
    maxPriorityFeePerGas: bigint,
    gasLimit?: bigint,
  ): Promise<void> {
    const { chain, signer, telemetry } = this.deps;
    const s = this.settings;
    const limit = gasLimit ?? (await chain.estimateGas({ from: signer.address, to: s.depositAddress, value }));
    const { raw, hash } = await signer.signTransaction({
      type: 2,
      chainId: s.chainId,
      nonce,
      to: s.depositAddress,
      value: value.toString(),
      gasLimit: limit.toString(),
      maxFeePerGas: maxFeePerGas.toString(),
      maxPriorityFeePerGas: maxPriorityFeePerGas.toString(),
      data: "0x",
    });
    const now = this.now();
    const tx: FundTx = {
      nonce,
      hash,
      raw,
      value: value.toString(),
      maxFeePerGas: maxFeePerGas.toString(),
      maxPriorityFeePerGas: maxPriorityFeePerGas.toString(),
      status: "signed",
      createdAt: now,
      updatedAt: now,
    };
    this.state.txs.push(tx);
    this.state.nextNonce = Math.max(this.state.nextNonce, nonce + 1);
    await this.save();
    await chain.send(raw);
    this.mark(tx, "broadcast");
    await this.save();
    telemetry.event("info", "arweave funder: top-up sent", { hash, nonce, value_wei: value.toString() });
  }

  private async maybeRenewApproval(): Promise<void> {
    const { irys, telemetry } = this.deps;
    const s = this.settings;
    const now = this.now();
    const current = await irys.approval(s.approvedAddress);
    const expiresIn = current.expiresAt === undefined ? Number.POSITIVE_INFINITY : current.expiresAt - now;
    const low = current.amount * 10n < s.approvalWei;
    const due = current.amount === 0n || expiresIn <= s.approvalRenewBeforeSeconds || low;
    if (!due) return;

    const windowStart = now - s.approvalTtlSeconds;
    const granted = this.state.approvals.filter((a) => a.at > windowStart).reduce((sum, a) => sum + BigInt(a.amount), 0n);
    if (granted + s.approvalWei > s.approvalWindowCapWei) {
      telemetry.gauge("arweave_funder_approval_cap_reached", 1);
      telemetry.event("error", "arweave funder: the upload key used its approval faster than the window allows; not renewing", {
        remaining_wei: current.amount.toString(),
        granted_in_window_wei: granted.toString(),
      });
      return;
    }
    telemetry.gauge("arweave_funder_approval_cap_reached", 0);
    // An Irys approval is replaced, not added to: this sets the remaining amount and the expiry outright.
    const id = await irys.createApproval(s.approvedAddress, s.approvalWei, s.approvalTtlSeconds);
    this.state.approvals.push({ at: now, amount: s.approvalWei.toString() });
    await this.save();
    telemetry.event("info", "arweave funder: approval renewed", {
      approved: s.approvedAddress,
      amount_wei: s.approvalWei.toString(),
      expires_in_seconds: s.approvalTtlSeconds,
      data_item: id,
    });
  }

  private mark(tx: FundTx, status: TxStatus): void {
    tx.status = status;
    tx.updatedAt = this.now();
  }

  private prune(): void {
    const now = this.now();
    this.state.approvals = this.state.approvals.filter((a) => a.at > now - APPROVAL_HISTORY_SECONDS);
    const groups = this.groups();
    this.state.txs = this.state.txs.filter((tx) => {
      const group = groups.get(tx.nonce)!;
      const final = group.every((t) => t.status === "credited" || t.status === "failed" || t.status === "dropped");
      return !final || tx.updatedAt > now - SETTLED_HISTORY_SECONDS;
    });
  }

  private async reportBalances(): Promise<void> {
    const { chain, irys, signer, telemetry } = this.deps;
    const s = this.settings;
    const [onChain, irysBalance, approval] = await Promise.all([
      chain.balance(signer.address),
      irys.balance(signer.address),
      irys.approval(s.approvedAddress),
    ]);
    telemetry.gauge("arweave_funder_chain_balance_eth", toEth(onChain));
    telemetry.gauge("arweave_funder_irys_balance_eth", toEth(irysBalance));
    telemetry.gauge("arweave_funder_approval_remaining_eth", toEth(approval.amount));
    if (approval.expiresAt !== undefined) telemetry.gauge("arweave_funder_approval_expires_in_seconds", approval.expiresAt - this.now());
    telemetry.gauge("arweave_funder_topped_up_24h_eth", toEth(this.toppedUpWithin(DAY_SECONDS)));
  }
}
