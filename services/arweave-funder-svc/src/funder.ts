import type { UnsignedTransaction } from "@ethersproject/transactions";

/**
 * One round of the Arweave funder: keeps the funding key's Turbo credits topped up from the ETH sent to its
 * address, and keeps a bounded, short-lived share of those credits in place for the upload key.
 *
 * What this code limits (recipient, per-top-up amount, daily total, fee cap, approval window) guards against
 * our own bugs only. Whoever holds this task role can call kms:Sign directly and skip all of it. The real
 * bounds are the key policy and how much ETH sits at the funding address; what this round adds against a
 * compromise is detection — every outgoing nonce must be one it recorded, or it halts and says so.
 */

export const STATE_SCHEMA = 2;
const DAY_SECONDS = 86_400;
const APPROVAL_HISTORY_SECONDS = 30 * DAY_SECONDS;
const SETTLED_HISTORY_SECONDS = 30 * DAY_SECONDS;
const RECEIPT_GRACE_SECONDS = 180;
// A landed top-up's receipt missing while its nonce stays spent is a lagging backend for seconds, not half an hour.
const SPENT_NONCE_GRACE_SECONDS = 30 * 60;
const PLAIN_TRANSFER_GAS = 21_000n;
// A signed EIP-1559 value transfer with empty data is about 115 bytes; the L1 fee is quoted for this many.
const TOP_UP_TX_BYTES = 150;

/**
 * `rejected`: mined, but Turbo refused to credit it. It is offered to Turbo again every round until its block is
 * safe, in case the refusal only meant Turbo had not seen it yet; after that the ETH is spent and bought nothing.
 * `reorged`: credited, then its block was reorganised away. It is never re-sent: Turbo already paid for it.
 */
export type TxStatus = "signed" | "broadcast" | "mined" | "credited" | "rejected" | "reorged" | "failed" | "dropped";

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
  /** Set once a receipt is seen: the block it landed in, when, and what it cost in L2 gas plus the L1 data fee. */
  blockNumber?: number;
  minedAt?: number;
  feeWei?: string;
  /** Set once that block is at or below the chain's `safe` head; after that the receipt is no longer rechecked. */
  confirmedAt?: number;
  /** When a landed top-up's receipt first went missing while the chain's nonce no longer covered it. */
  receiptMissingSince?: number;
};

export type FunderState = {
  schema: typeof STATE_SCHEMA;
  /** The next nonce this funder will use. The chain's nonce must never pass it. */
  nextNonce: number;
  lease?: { holder: string; until: number };
  halted?: { reason: string; at: number; hash?: string };
  txs: FundTx[];
  /** Credit shares granted to the upload key, in winc. */
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
  receipt(hash: string): Promise<Receipt | undefined>;
  /** The newest block the chain treats as safe from reorganisation. */
  safeBlock(): Promise<number>;
  /** An upper bound on the L1 data fee an OP-stack chain adds to a transaction of this many bytes. */
  l1FeeUpperBound(txBytes: number): Promise<bigint>;
}

export type Receipt = { status: 0 | 1; blockNumber: number; feeWei: bigint };

/** Turbo's payment and upload services, as seen by the wallet that buys credits. Amounts are in winc. */
export interface Bundler {
  depositAddress(): Promise<string>;
  balance(address: string): Promise<bigint>;
  /** What is left of the unexpired credits this wallet shared with `approvedAddress`, and when the last of them lapses. */
  shared(approvedAddress: string): Promise<{ amount: bigint; expiresAt?: number }>;
  /** Shares are added, not replaced: each one stands until it is spent or expires. */
  shareCredits(approvedAddress: string, amount: bigint, expiresInSeconds: number): Promise<string>;
  /** `credited` once Turbo has added the deposit to the sender's credits; `pending` while it waits for confirmations. */
  submitFundTransaction(hash: string): Promise<"credited" | "pending" | "rejected">;
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
  creditsLowWinc: bigint;
  topUpWei: bigint;
  dailyTopUpCapWei: bigint;
  maxFeePerGasWei: bigint;
  maxGasLimit: bigint;
  stuckAfterSeconds: number;
  /** A nonce is re-priced at most this many times; past it the funder only watches and raises arweave_funder_tx_stuck. */
  maxReplacements: number;
  /** Whether the chain charges an L1 data fee the balance check must cover (Base and other OP-stack chains). */
  l1DataFee: boolean;
  shareWinc: bigint;
  shareTtlSeconds: number;
  shareRenewBeforeSeconds: number;
  /** Shares granted within any shareTtlSeconds window may not sum past this: the most a stolen upload key can spend in one window. */
  shareWindowCapWinc: bigint;
  leaseSeconds: number;
  holder: string;
};

export type RoundOutcome = "lease-held" | "conflict" | "halted" | "done";

class Conflict extends Error {}

/** The bundler answered that it made no share; any other failure may have made one. */
export class ShareRefused extends Error {}

const WEI_PER_ETH = 10n ** 18n;
const WINC_PER_CREDIT = 10n ** 12n;
const toEth = (wei: bigint): number => Number(wei) / Number(WEI_PER_ETH);
const toCredits = (winc: bigint): number => Number(winc) / Number(WINC_PER_CREDIT);
const lower = (address: string): string => address.toLowerCase();

export class FunderRound {
  private state!: FunderState;
  private version: string | null = null;

  constructor(
    private readonly settings: FunderSettings,
    private readonly deps: {
      chain: Chain;
      bundler: Bundler;
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
      // Held for as long as the halt that raised them, so their alarms do not clear while nothing is signed.
      const cause = this.state.txs.find((tx) => tx.hash === this.state.halted!.hash);
      telemetry.gauge("arweave_funder_credit_rejected", cause?.status === "rejected" ? 1 : 0);
      telemetry.gauge("arweave_funder_reorged", cause?.status === "reorged" ? 1 : 0);
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
    if ((await this.recheckLanded(latest)) === "halted") return "halted";
    await this.creditMined();
    // A top-up that cannot proceed (RPC trouble, fees) must not also keep the upload key's share from renewing:
    // the share is what uploads run on, and it needs no ETH.
    let topUpError: unknown;
    try {
      if ((await this.maybeTopUp(latest)) === "halted") return "halted";
    } catch (error) {
      if (error instanceof Conflict) throw error;
      topUpError = error;
    }
    await this.maybeRenewShare();
    if (topUpError !== undefined) {
      await this.save();
      throw topUpError;
    }
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

  private async halt(reason: string, hash?: string): Promise<"halted"> {
    this.state.halted = { reason, at: this.now(), ...(hash ? { hash } : {}) };
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
    return group.some((tx) => tx.status === "mined" || tx.status === "credited" || tx.status === "rejected" || tx.status === "reorged" || tx.status === "failed");
  }

  private async reconcileInFlight(latest: number): Promise<"halted" | "ok"> {
    const { chain, telemetry } = this.deps;
    let stuck = false;
    for (const [nonce, group] of this.groups()) {
      if (FunderRound.settled(group)) continue;
      const live = group.filter((tx) => tx.status === "signed" || tx.status === "broadcast");
      let landed: { tx: FundTx; receipt: Receipt } | undefined;
      for (const tx of live) {
        const receipt = await chain.receipt(tx.hash);
        if (receipt) landed = { tx, receipt };
      }
      if (landed) {
        for (const tx of live) this.mark(tx, tx === landed.tx ? (landed.receipt.status === 1 ? "mined" : "failed") : "dropped");
        this.recordLanding(landed.tx, landed.receipt);
        if (landed.receipt.status === 0) telemetry.event("error", "arweave funder: top-up transaction reverted", { hash: landed.tx.hash, nonce });
        await this.save();
        continue;
      }
      // Receipts first: a signed transaction whose nonce another of the group already used can never be sent.
      for (const tx of live) {
        if (tx.status !== "signed") continue;
        try {
          await chain.send(tx.raw);
        } catch (error) {
          telemetry.event("warn", "arweave funder: a signed top-up could not be broadcast; retrying next round", {
            hash: tx.hash,
            nonce,
            error: error instanceof Error ? error.message : String(error),
          });
          continue;
        }
        this.mark(tx, "broadcast");
        await this.save();
      }
      const newest = live.reduce((a, b) => (a.createdAt >= b.createdAt ? a : b));
      if (latest > nonce) {
        // A receipt can trail the nonce on a load-balanced RPC; only a gap that outlasts that is someone else's transaction.
        if (this.now() - newest.updatedAt < RECEIPT_GRACE_SECONDS) continue;
        return this.halt(`nonce ${nonce} was consumed by a transaction this funder did not record`);
      }
      if (this.now() - newest.createdAt < this.settings.stuckAfterSeconds) continue;
      if (group.length - 1 >= this.settings.maxReplacements) {
        stuck = true;
        telemetry.event("warn", "arweave funder: a top-up is still unmined after its last allowed replacement; watching it, not re-pricing it", {
          hash: newest.hash,
          nonce,
          replacements: group.length - 1,
        });
        continue;
      }
      await this.replace(newest);
    }
    telemetry.gauge("arweave_funder_tx_stuck", stuck ? 1 : 0);
    return "ok";
  }

  private recordLanding(tx: FundTx, receipt: Receipt): void {
    tx.blockNumber = receipt.blockNumber;
    tx.minedAt = this.now();
    tx.feeWei = receipt.feeWei.toString();
  }

  /**
   * A landed top-up's receipt is rechecked until its block is safe. It counts as reorganised away only once the
   * chain's nonce no longer covers it either, for longer than a lagging RPC backend could explain. Lost before Turbo
   * credited it, the same bytes go out again. Lost after, the funder halts: Turbo has paid for it, and the network
   * may yet include it again.
   */
  private async recheckLanded(latest: number): Promise<"halted" | "ok"> {
    const { chain, telemetry } = this.deps;
    const watched = this.state.txs.filter((tx) => tx.blockNumber !== undefined && tx.confirmedAt === undefined && tx.status !== "reorged");
    telemetry.gauge("arweave_funder_reorged", 0);
    telemetry.gauge("arweave_funder_credit_rejected", 0);
    if (watched.length > 0) {
      const safe = await chain.safeBlock();
      for (const tx of watched) {
        const receipt = await chain.receipt(tx.hash);
        if (!receipt && latest > tx.nonce) {
          tx.receiptMissingSince ??= this.now();
          const adopted = await this.adoptReplacement(tx);
          if (adopted === "halted") return "halted";
          if (adopted === "adopted") continue;
          // Spent nonce, no receipt for any transaction this funder signed: past the grace, someone else's spent it.
          if (this.now() - tx.receiptMissingSince < SPENT_NONCE_GRACE_SECONDS) continue;
          return this.halt(`nonce ${tx.nonce} was consumed by a transaction this funder did not record, after top-up ${tx.hash} landed`, tx.hash);
        }
        if (receipt) {
          delete tx.receiptMissingSince;
          if (receipt.blockNumber !== tx.blockNumber) this.recordLanding(tx, receipt);
          if (receipt.blockNumber <= safe) {
            tx.confirmedAt = this.now();
            if (tx.status === "rejected") {
              // Signing on would repeat whatever made Turbo refuse it, up to the daily cap every day.
              telemetry.gauge("arweave_funder_credit_rejected", 1);
              return this.halt(`Turbo refuses top-up ${tx.hash} (nonce ${tx.nonce}, ${tx.value} wei), whose block is now safe`, tx.hash);
            }
          }
          continue;
        }
        tx.receiptMissingSince ??= this.now();
        if (this.now() - tx.receiptMissingSince < RECEIPT_GRACE_SECONDS) continue;
        if ((await this.dropReorged(tx)) === "halted") return "halted";
      }
      await this.save();
    }
    return "ok";
  }

  /**
   * The nonce is spent but this transaction has no receipt: a replacement of the same nonce may have landed in its
   * place after a reorganisation. Before Turbo credited it, the replacement takes over as the landed top-up; after,
   * the funder halts, because Turbo credited a transfer the chain no longer holds.
   */
  private async adoptReplacement(tx: FundTx): Promise<"halted" | "adopted" | "none"> {
    for (const sibling of this.groups().get(tx.nonce)!) {
      if (sibling === tx || sibling.status !== "dropped") continue;
      const receipt = await this.deps.chain.receipt(sibling.hash);
      if (!receipt) continue;
      if (tx.status !== "mined" && tx.status !== "failed") {
        const settledAs = tx.status === "credited" ? "credited by Turbo" : "refused by Turbo";
        this.mark(tx, "reorged");
        this.deps.telemetry.gauge("arweave_funder_reorged", 1);
        return this.halt(`top-up ${tx.hash} (nonce ${tx.nonce}) was ${settledAs}, then replaced on chain by ${sibling.hash}`, tx.hash);
      }
      delete tx.blockNumber;
      delete tx.minedAt;
      delete tx.feeWei;
      delete tx.receiptMissingSince;
      this.mark(tx, "dropped");
      this.mark(sibling, receipt.status === 1 ? "mined" : "failed");
      this.recordLanding(sibling, receipt);
      this.deps.telemetry.event("warn", "arweave funder: a reorganisation replaced a landed top-up with another of the same nonce", {
        was: tx.hash,
        now: sibling.hash,
        nonce: tx.nonce,
      });
      return "adopted";
    }
    return "none";
  }

  private async dropReorged(tx: FundTx): Promise<"halted" | "ok"> {
    const { chain, telemetry } = this.deps;
    if (tx.status === "mined" || tx.status === "failed") {
      for (const sibling of this.groups().get(tx.nonce)!) {
        if (sibling.status !== "dropped" && sibling !== tx) continue;
        delete sibling.blockNumber;
        delete sibling.minedAt;
        delete sibling.feeWei;
        delete sibling.receiptMissingSince;
        await chain.send(sibling.raw);
        this.mark(sibling, "broadcast");
        sibling.createdAt = this.now();
      }
      telemetry.event("warn", "arweave funder: a landed top-up's block was reorganised away before Turbo credited it; re-sent", { hash: tx.hash, nonce: tx.nonce });
      return "ok";
    }
    const settledAs = tx.status === "credited" ? "credited by Turbo" : "refused by Turbo";
    this.mark(tx, "reorged");
    telemetry.gauge("arweave_funder_reorged", 1);
    return this.halt(`top-up ${tx.hash} (nonce ${tx.nonce}) was ${settledAs}, then reorganised out of the chain`, tx.hash);
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

  private static awaitingCredit(tx: FundTx): boolean {
    return tx.status === "mined" || (tx.status === "rejected" && tx.confirmedAt === undefined);
  }

  private async creditMined(): Promise<void> {
    for (const tx of this.state.txs) {
      if (!FunderRound.awaitingCredit(tx)) continue;
      let result: "credited" | "pending" | "rejected";
      try {
        result = await this.deps.bundler.submitFundTransaction(tx.hash);
      } catch (error) {
        this.deps.telemetry.event("warn", "arweave funder: Turbo did not answer for a mined top-up; offering it again next round", {
          hash: tx.hash,
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      if (result === "pending" || result === tx.status) continue;
      if (result === "rejected") {
        this.deps.telemetry.event("warn", "arweave funder: Turbo refused to credit a mined top-up; offering it again until its block is safe", {
          hash: tx.hash,
          nonce: tx.nonce,
          value_wei: tx.value,
        });
      }
      this.mark(tx, result);
      await this.save();
    }
  }

  private feesWithin(seconds: number): bigint {
    const since = this.now() - seconds;
    return this.state.txs.reduce((sum, tx) => (tx.feeWei !== undefined && (tx.minedAt ?? 0) >= since ? sum + BigInt(tx.feeWei) : sum), 0n);
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
    const { chain, bundler, signer, telemetry } = this.deps;
    const s = this.settings;
    const inFlight = this.state.txs.some((tx) => tx.status === "signed" || tx.status === "broadcast" || FunderRound.awaitingCredit(tx));
    if (inFlight) return "ok";

    const credits = await bundler.balance(signer.address);
    if (credits >= s.creditsLowWinc) return "ok";

    const toppedUp = this.toppedUpWithin(DAY_SECONDS);
    if (toppedUp + s.topUpWei > s.dailyTopUpCapWei) {
      telemetry.gauge("arweave_funder_daily_cap_reached", 1);
      telemetry.event("warn", "arweave funder: Turbo credits are low but today's top-ups have reached the daily cap", {
        topped_up_wei: toppedUp.toString(),
      });
      return "ok";
    }
    telemetry.gauge("arweave_funder_daily_cap_reached", 0);

    const reported = lower(await bundler.depositAddress());
    if (reported !== lower(s.depositAddress)) {
      return this.halt(`Turbo reports deposit address ${reported}, configured ${lower(s.depositAddress)}`);
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

    // Half again over the quote: the L1 fee moves with Ethereum's blob and base fees between quote and inclusion.
    const l1Fee = s.l1DataFee ? ((await chain.l1FeeUpperBound(TOP_UP_TX_BYTES)) * 3n) / 2n : 0n;
    // Balance first: a node refuses to estimate a value transfer the sender cannot cover, so an empty wallet would
    // otherwise fail the round here instead of reporting that it is empty.
    const onChain = await chain.balance(signer.address);
    if (onChain < s.topUpWei + PLAIN_TRANSFER_GAS * fees.maxFeePerGas + l1Fee) {
      telemetry.event("warn", "arweave funder: Turbo credits are low and the funding address holds too little ETH to top it up", {
        address: signer.address,
        balance_wei: onChain.toString(),
      });
      return "ok";
    }
    // Estimated without the value: the gas of a transfer to an account does not depend on the amount.
    const gasLimit = await chain.estimateGas({ from: signer.address, to: s.depositAddress, value: 0n });
    if (gasLimit > s.maxGasLimit) throw new Error(`a top-up would need ${gasLimit} gas, above the ${s.maxGasLimit} limit`);
    if (onChain < s.topUpWei + gasLimit * fees.maxFeePerGas + l1Fee) {
      telemetry.event("warn", "arweave funder: Turbo credits are low and the funding address holds too little ETH to top it up", {
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
    const limit = gasLimit ?? (await chain.estimateGas({ from: signer.address, to: s.depositAddress, value: 0n }));
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
    try {
      await chain.send(raw);
    } catch (error) {
      telemetry.event("warn", "arweave funder: a signed top-up could not be broadcast; retrying next round", {
        hash,
        nonce,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    this.mark(tx, "broadcast");
    await this.save();
    telemetry.event("info", "arweave funder: top-up sent", { hash, nonce, value_wei: value.toString() });
  }

  private async maybeRenewShare(): Promise<void> {
    const { bundler, signer, telemetry } = this.deps;
    const s = this.settings;
    const now = this.now();
    const current = await bundler.shared(s.approvedAddress);
    const expiresIn = current.expiresAt === undefined ? Number.POSITIVE_INFINITY : current.expiresAt - now;
    const low = current.amount * 10n < s.shareWinc;
    const due = current.amount === 0n || expiresIn <= s.shareRenewBeforeSeconds || low;
    if (!due) return;

    const windowStart = now - s.shareTtlSeconds;
    const granted = this.state.approvals.filter((a) => a.at > windowStart).reduce((sum, a) => sum + BigInt(a.amount), 0n);
    if (granted + s.shareWinc > s.shareWindowCapWinc) {
      telemetry.gauge("arweave_funder_approval_cap_reached", 1);
      telemetry.event("error", "arweave funder: the upload key used its shared credits faster than the window allows; not sharing more", {
        remaining_winc: current.amount.toString(),
        granted_in_window_winc: granted.toString(),
      });
      return;
    }
    telemetry.gauge("arweave_funder_approval_cap_reached", 0);
    // Turbo sets a share aside from the payer's spendable credits, and refuses one it cannot cover.
    const spendable = await bundler.balance(signer.address);
    if (spendable < s.shareWinc) {
      telemetry.gauge("arweave_funder_share_unfunded", 1);
      telemetry.event("warn", "arweave funder: too few spendable credits to share with the upload key; waiting for a top-up", {
        spendable_winc: spendable.toString(),
        share_winc: s.shareWinc.toString(),
      });
      return;
    }
    telemetry.gauge("arweave_funder_share_unfunded", 0);
    // Recorded before Turbo is asked, as a transaction is before it is sent: a share whose answer is lost still counts
    // against the window. Only an answer that says no share was made takes the record back.
    const record = { at: now, amount: s.shareWinc.toString() };
    this.state.approvals.push(record);
    await this.save();
    let id: string;
    try {
      id = await bundler.shareCredits(s.approvedAddress, s.shareWinc, s.shareTtlSeconds);
    } catch (error) {
      if (error instanceof ShareRefused) {
        this.state.approvals = this.state.approvals.filter((a) => a !== record);
        await this.save();
      }
      throw error;
    }
    telemetry.event("info", "arweave funder: credits shared with the upload key", {
      approved: s.approvedAddress,
      amount_winc: s.shareWinc.toString(),
      expires_in_seconds: s.shareTtlSeconds,
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
      const final = group.every(
        (t) => (t.status === "credited" || t.status === "rejected" || t.status === "failed" || t.status === "reorged" || t.status === "dropped") &&
          (t.blockNumber === undefined || t.confirmedAt !== undefined || t.status === "reorged"),
      );
      return !final || tx.updatedAt > now - SETTLED_HISTORY_SECONDS;
    });
  }

  private async reportBalances(): Promise<void> {
    const { chain, bundler, signer, telemetry } = this.deps;
    const s = this.settings;
    const [onChain, credits, shared] = await Promise.all([
      chain.balance(signer.address),
      bundler.balance(signer.address),
      bundler.shared(s.approvedAddress),
    ]);
    telemetry.gauge("arweave_funder_chain_balance_eth", toEth(onChain));
    telemetry.gauge("arweave_funder_credits_balance", toCredits(credits));
    telemetry.gauge("arweave_funder_shared_remaining_credits", toCredits(shared.amount));
    if (shared.expiresAt !== undefined) telemetry.gauge("arweave_funder_approval_expires_in_seconds", shared.expiresAt - this.now());
    telemetry.gauge("arweave_funder_topped_up_24h_eth", toEth(this.toppedUpWithin(DAY_SECONDS)));
    telemetry.gauge("arweave_funder_fees_24h_eth", toEth(this.feesWithin(DAY_SECONDS)));
  }
}
