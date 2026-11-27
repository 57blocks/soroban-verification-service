import { FunderRound, ShareRefused, type Bundler, type Chain, type FunderSettings, type FunderState, type FundTx, type StateStore, type TxSigner } from "../src/funder.js";

const FUNDER = "0x00000000000000000000000000000000000000f0";
const DEPOSIT = "0x00000000000000000000000000000000000000d0";
const UPLOADER = "0x00000000000000000000000000000000000000a0";
const ETH = 10n ** 18n;
const CREDIT = 10n ** 12n;
const GWEI = 10n ** 9n;
const T0 = 1_800_000_000;

const SETTINGS: FunderSettings = {
  chainId: 84532,
  depositAddress: DEPOSIT,
  approvedAddress: UPLOADER,
  creditsLowWinc: CREDIT / 10n,
  topUpWei: ETH / 5n,
  dailyTopUpCapWei: ETH / 2n,
  maxFeePerGasWei: 10n * GWEI,
  maxGasLimit: 60_000n,
  stuckAfterSeconds: 900,
  maxReplacements: 5,
  l1DataFee: true,
  shareWinc: CREDIT / 20n,
  shareTtlSeconds: 7 * 86_400,
  shareRenewBeforeSeconds: 86_400,
  shareWindowCapWinc: CREDIT / 10n,
  leaseSeconds: 900,
  holder: "me",
};

class FakeChain implements Chain {
  id = 84532;
  latest = 0;
  wei = 5n * ETH;
  fee = { maxFeePerGas: 2n * GWEI, maxPriorityFeePerGas: GWEI / 1000n };
  sent: string[] = [];
  receipts = new Map<string, { status: 0 | 1; blockNumber: number; feeWei: bigint }>();
  height = 100;
  safe = 0;
  l1Fee = 0n;
  async chainId() {
    return this.id;
  }
  async nonce() {
    return this.latest;
  }
  async balance() {
    return this.wei;
  }
  async fees() {
    return this.fee;
  }
  estimates: bigint[] = [];
  async estimateGas(tx: { value: bigint }) {
    // Like a real node: estimating a value transfer the sender cannot cover fails.
    if (tx.value > this.wei) throw new Error("eth_estimateGas: EVM error: OutOfFunds (-32003)");
    this.estimates.push(tx.value);
    return 21_000n;
  }
  async send(raw: string) {
    this.sent.push(raw);
  }
  async receipt(hash: string) {
    return this.receipts.get(hash);
  }
  async safeBlock() {
    return this.safe;
  }
  async l1FeeUpperBound() {
    return this.l1Fee;
  }
  mine(hash: string, status: 0 | 1 = 1) {
    this.height += 1;
    this.receipts.set(hash, { status, blockNumber: this.height, feeWei: 21_000n * GWEI });
    this.latest += 1;
  }
  reorg(hash: string) {
    this.receipts.delete(hash);
    this.latest -= 1;
  }
}

class FakeTurbo implements Bundler {
  deposit = DEPOSIT;
  credits = 0n;
  sharedAmount = 0n;
  sharedExpiresAt: number | undefined;
  approvals: { amount: bigint; ttl: number }[] = [];
  submitted: string[] = [];
  credit: "credited" | "pending" | "rejected" = "credited";
  async depositAddress() {
    return this.deposit;
  }
  async balance() {
    return this.credits;
  }
  listed: string[] = [];
  signed = 0;
  /** Makes the next submit fail; `made` says whether Turbo made the share before the answer was lost. */
  failNext: { error: Error; made: boolean } | undefined;
  async shared() {
    return { amount: this.sharedAmount, ...(this.sharedExpiresAt === undefined ? {} : { expiresAt: this.sharedExpiresAt }), ids: [...this.listed] };
  }
  async signShare(_approved: string, amount: bigint, ttl: number) {
    this.signed += 1;
    const id = `share-${this.signed}`;
    return {
      id,
      submit: async () => {
        const failure = this.failNext;
        this.failNext = undefined;
        if (!failure || failure.made) {
          this.approvals.push({ amount, ttl });
          this.sharedAmount += amount;
          this.sharedExpiresAt = Math.max(this.sharedExpiresAt ?? 0, clock.now + ttl);
          this.listed.push(id);
        }
        if (failure) throw failure.error;
        return `approval-${id}`;
      },
    };
  }
  async submitFundTransaction(hash: string) {
    this.submitted.push(hash);
    return this.credit;
  }
}

class FakeStore implements StateStore {
  state: FunderState | undefined;
  version = 0;
  writes = 0;
  /** Simulates another writer: the next save fails its precondition. */
  stealNext = false;
  async load() {
    return { state: this.state ? (JSON.parse(JSON.stringify(this.state)) as FunderState) : undefined, version: this.state ? String(this.version) : null };
  }
  async save(state: FunderState, version: string | null) {
    if (this.stealNext) {
      this.stealNext = false;
      this.version += 1;
      return false as const;
    }
    if ((this.state ? String(this.version) : null) !== version) return false as const;
    this.state = JSON.parse(JSON.stringify(state)) as FunderState;
    this.version += 1;
    this.writes += 1;
    return String(this.version);
  }
}

class FakeSigner implements TxSigner {
  address = FUNDER;
  signed: { nonce: number; maxFeePerGas: string }[] = [];
  async signTransaction(tx: { nonce?: number; maxFeePerGas?: unknown }) {
    const n = this.signed.length;
    this.signed.push({ nonce: tx.nonce!, maxFeePerGas: String(tx.maxFeePerGas) });
    return { raw: `0xraw${n}`, hash: `0xhash${n}` };
  }
}

const clock = { now: T0 };

function setup(overrides: Partial<FunderSettings> = {}) {
  const chain = new FakeChain();
  const bundler = new FakeTurbo();
  const store = new FakeStore();
  const signer = new FakeSigner();
  const events: { level: string; msg: string }[] = [];
  const gauges = new Map<string, number>();
  const round = (holder = "me") =>
    new FunderRound(
      { ...SETTINGS, ...overrides, holder },
      {
        chain,
        bundler,
        store,
        signer,
        telemetry: { gauge: (n, v) => gauges.set(n, v), event: (level, msg) => events.push({ level, msg }) },
        now: () => clock.now * 1000,
      },
    ).run();
  return { chain, bundler, store, signer, events, gauges, round };
}

const txs = (store: FakeStore): FundTx[] => store.state?.txs ?? [];

beforeEach(() => {
  clock.now = T0;
});

describe("topping up", () => {
  it("records the signed transaction before broadcasting it, then credits it once mined", async () => {
    const { chain, bundler, store, round } = setup();

    await expect(round()).resolves.toBe("done");
    expect(chain.sent).toEqual(["0xraw0"]);
    expect(txs(store)).toMatchObject([{ nonce: 0, hash: "0xhash0", status: "broadcast", value: (ETH / 5n).toString() }]);
    expect(store.state?.nextNonce).toBe(1);

    chain.mine("0xhash0");
    clock.now += 300;
    await round();
    expect(bundler.submitted).toEqual(["0xhash0"]);
    expect(txs(store)[0]?.status).toBe("credited");
  });

  it("does nothing while the Turbo credits are above the low-water mark", async () => {
    const { chain, bundler, round } = setup();
    bundler.credits = CREDIT;
    await round();
    expect(chain.sent).toEqual([]);
  });

  it("keeps retrying the credit with the same hash, and never sends a second transfer for it", async () => {
    const { chain, bundler, store, round } = setup();
    await round();
    chain.mine("0xhash0");
    bundler.credit = "pending";
    for (let i = 0; i < 3; i += 1) {
      clock.now += 300;
      await round();
    }
    expect(bundler.submitted).toEqual(["0xhash0", "0xhash0", "0xhash0"]);
    expect(chain.sent).toEqual(["0xraw0"]);
    expect(txs(store)[0]?.status).toBe("mined");
  });

  it("keeps offering a refused deposit to Turbo while its block is not yet safe, and takes a later credit", async () => {
    const { chain, bundler, store, gauges, round } = setup();
    await round();
    chain.mine("0xhash0");
    bundler.credit = "rejected";
    clock.now += 300;
    await round();
    expect(txs(store)[0]?.status).toBe("rejected");
    expect(gauges.get("arweave_funder_credit_rejected")).toBe(0);
    bundler.credit = "credited";
    bundler.credits = CREDIT;
    clock.now += 300;
    await round();
    expect(txs(store)[0]?.status).toBe("credited");
    expect(bundler.submitted).toEqual(["0xhash0", "0xhash0"]);
    expect(chain.sent).toEqual(["0xraw0"]);
  });

  it("halts once Turbo still refuses a deposit whose block is safe, and holds the alarm for as long as it is halted", async () => {
    const { chain, bundler, store, gauges, round } = setup();
    await round();
    chain.mine("0xhash0");
    bundler.credit = "rejected";
    clock.now += 300;
    await round();
    chain.safe = 101;
    clock.now += 300;
    await expect(round()).resolves.toBe("halted");
    expect(txs(store)[0]).toMatchObject({ status: "rejected", confirmedAt: clock.now });
    expect(store.state?.halted).toMatchObject({ hash: "0xhash0" });
    expect(store.state?.halted?.reason).toMatch(/Turbo refuses top-up 0xhash0 .* whose block is now safe/);
    expect(gauges.get("arweave_funder_credit_rejected")).toBe(1);
    for (let i = 0; i < 3; i += 1) {
      clock.now += 300;
      await expect(round()).resolves.toBe("halted");
      expect(gauges.get("arweave_funder_credit_rejected")).toBe(1);
    }
    expect(bundler.submitted).toEqual(["0xhash0"]);
    expect(chain.sent).toEqual(["0xraw0"]);
  });

  it("counts a refused deposit against the daily cap once the halt is cleared", async () => {
    const { chain, bundler, store, gauges, round } = setup({ dailyTopUpCapWei: ETH / 4n });
    await round();
    chain.mine("0xhash0");
    bundler.credit = "rejected";
    clock.now += 300;
    await round();
    chain.safe = 101;
    clock.now += 300;
    await round();
    delete store.state!.halted;
    clock.now += 300;
    await expect(round()).resolves.toBe("done");
    expect(gauges.get("arweave_funder_credit_rejected")).toBe(0);
    expect(chain.sent).toEqual(["0xraw0"]);
    expect(gauges.get("arweave_funder_daily_cap_reached")).toBe(1);
  });

  it("re-sends the recorded bytes when it stopped between signing and broadcasting", async () => {
    const { chain, store, round, signer } = setup();
    store.state = {
      schema: 2,
      nextNonce: 1,
      txs: [{ nonce: 0, hash: "0xh", raw: "0xrecorded", value: "1", maxFeePerGas: "1", maxPriorityFeePerGas: "1", status: "signed", createdAt: T0, updatedAt: T0 }],
      approvals: [],
    };
    await round();
    expect(chain.sent).toEqual(["0xrecorded"]);
    expect(signer.signed).toEqual([]);
    expect(txs(store)[0]?.status).toBe("broadcast");
  });

  it("stops at the daily cap", async () => {
    const { chain, bundler, gauges, round } = setup({ dailyTopUpCapWei: ETH / 4n });
    await round();
    chain.mine("0xhash0");
    clock.now += 300;
    await round();
    bundler.credits = 0n;
    clock.now += 300;
    await round();
    expect(chain.sent).toEqual(["0xraw0"]);
    expect(gauges.get("arweave_funder_daily_cap_reached")).toBe(1);
  });

  it("does not top up when fees are above the cap", async () => {
    const { chain, gauges, round } = setup();
    chain.fee = { maxFeePerGas: 50n * GWEI, maxPriorityFeePerGas: GWEI };
    await round();
    expect(chain.sent).toEqual([]);
    expect(gauges.get("arweave_funder_fee_cap_reached")).toBe(1);
  });

  it("does not top up when the address cannot cover the transfer and its gas", async () => {
    const { chain, round } = setup();
    chain.wei = ETH / 5n;
    await round();
    expect(chain.sent).toEqual([]);
  });

  it("reports an empty funding address as empty, and still keeps the share in place", async () => {
    const { chain, bundler, round } = setup();
    bundler.credits = CREDIT / 20n;
    chain.wei = 0n;
    await expect(round()).resolves.toBe("done");
    expect(chain.sent).toEqual([]);
    expect(bundler.approvals).toHaveLength(1);
  });

  it("estimates the transfer's gas without its value", async () => {
    const { chain, round } = setup();
    await round();
    expect(chain.estimates).toEqual([0n]);
  });

  it("still renews the share when the top-up fails, then reports the failure", async () => {
    const { chain, bundler, round } = setup();
    bundler.credits = CREDIT / 20n;
    chain.fees = async () => {
      throw new Error("RPC down");
    };
    await expect(round()).rejects.toThrow(/RPC down/);
    expect(bundler.approvals).toHaveLength(1);
  });

  it("refuses to sign for a different chain", async () => {
    const { chain, round } = setup();
    chain.id = 1;
    await expect(round()).rejects.toThrow(/chain 1, configured for 84532/);
    expect(chain.sent).toEqual([]);
  });
});

describe("halting", () => {
  it("halts, and stays halted, when Turbo reports a deposit address other than the configured one", async () => {
    const { chain, bundler, store, round } = setup();
    bundler.deposit = "0x00000000000000000000000000000000000000ee";
    await expect(round()).resolves.toBe("halted");
    expect(store.state?.halted?.reason).toMatch(/deposit address/);
    bundler.deposit = DEPOSIT;
    await expect(round()).resolves.toBe("halted");
    expect(chain.sent).toEqual([]);
  });

  it("halts when the chain shows a transfer this funder did not record", async () => {
    const { chain, bundler, store, round, gauges } = setup();
    await round();
    chain.mine("0xhash0");
    bundler.credits = CREDIT;
    clock.now += 300;
    await round();
    chain.latest += 1; // someone used the key outside this code
    clock.now += 300;
    await expect(round()).resolves.toBe("halted");
    expect(store.state?.halted?.reason).toMatch(/unexpected outflow: .* sent 2 transactions, this funder accounts for 1/);
    expect(gauges.get("arweave_funder_halted")).toBe(1);
  });

  it("halts when its own pending nonce is consumed by another transaction, after a grace for lagging receipts", async () => {
    const { chain, store, round } = setup();
    await round();
    chain.latest = 1; // nonce 0 used, but not by 0xhash0
    clock.now += 60;
    await expect(round()).resolves.toBe("done");
    clock.now += 300;
    await expect(round()).resolves.toBe("halted");
    expect(store.state?.halted?.reason).toMatch(/nonce 0 was consumed/);
  });
});

describe("stuck transactions", () => {
  it("replaces a stuck top-up with the same nonce and fees raised by at least 12.5%", async () => {
    const { chain, bundler, signer, store, round } = setup();
    await round();
    clock.now += 901;
    await round();
    expect(signer.signed.map((s) => s.nonce)).toEqual([0, 0]);
    expect(BigInt(signer.signed[1]!.maxFeePerGas)).toBeGreaterThanOrEqual((BigInt(signer.signed[0]!.maxFeePerGas) * 1125n) / 1000n);
    expect(chain.sent).toEqual(["0xraw0", "0xraw1"]);

    chain.mine("0xhash1");
    bundler.credits = CREDIT;
    clock.now += 60;
    await round();
    expect(txs(store).map((t) => t.status)).toEqual(["dropped", "credited"]);
  });

  it("stops re-pricing after the last allowed replacement, keeps watching, and raises tx_stuck", async () => {
    const { chain, gauges, round } = setup({ maxReplacements: 2 });
    await round();
    for (let i = 0; i < 4; i += 1) {
      clock.now += 901;
      await round();
    }
    expect(chain.sent).toEqual(["0xraw0", "0xraw1", "0xraw2"]);
    expect(gauges.get("arweave_funder_tx_stuck")).toBe(1);
    chain.mine("0xhash2");
    clock.now += 60;
    await round();
    expect(gauges.get("arweave_funder_tx_stuck")).toBe(0);
  });

  it("leaves a stuck top-up alone when replacing it would exceed the fee cap", async () => {
    const { chain, gauges, round } = setup({ maxFeePerGasWei: 2n * GWEI + 1n });
    await round();
    clock.now += 901;
    await round();
    expect(chain.sent).toEqual(["0xraw0"]);
    expect(gauges.get("arweave_funder_fee_cap_reached")).toBe(1);
  });
});

describe("after a top-up lands", () => {
  it("records what it cost, and stops rechecking it once its block is safe", async () => {
    const { chain, store, gauges, round } = setup();
    await round();
    chain.mine("0xhash0");
    clock.now += 300;
    await round();
    expect(txs(store)[0]).toMatchObject({ status: "credited", blockNumber: 101, feeWei: (21_000n * GWEI).toString() });
    expect(txs(store)[0]?.confirmedAt).toBeUndefined();
    expect(gauges.get("arweave_funder_fees_24h_eth")).toBeCloseTo(21_000 / 1e9);
    chain.safe = 101;
    clock.now += 300;
    await round();
    expect(txs(store)[0]?.confirmedAt).toBe(clock.now);
    chain.receipts.clear();
    clock.now += 300;
    await round();
    expect(txs(store)[0]?.status).toBe("credited");
  });

  it("re-sends the same bytes when its block is reorganised away before Turbo credits it", async () => {
    const { chain, bundler, store, signer, round } = setup();
    await round();
    chain.mine("0xhash0");
    bundler.credit = "pending";
    clock.now += 300;
    await round();
    expect(txs(store)[0]?.status).toBe("mined");
    chain.reorg("0xhash0");
    clock.now += 60;
    await round();
    expect(chain.sent).toEqual(["0xraw0"]);
    clock.now += 300;
    await round();
    expect(chain.sent).toEqual(["0xraw0", "0xraw0"]);
    expect(signer.signed).toHaveLength(1);
    expect(txs(store)[0]).toMatchObject({ status: "broadcast" });
    expect(txs(store)[0]?.blockNumber).toBeUndefined();
  });

  it("halts, and never re-sends, when a credited top-up's block is reorganised away", async () => {
    const { chain, bundler, store, gauges, round } = setup();
    await round();
    chain.mine("0xhash0");
    bundler.credits = CREDIT;
    clock.now += 300;
    await round();
    expect(txs(store)[0]?.status).toBe("credited");
    chain.reorg("0xhash0");
    clock.now += 60;
    await round();
    expect(txs(store)[0]?.status).toBe("credited");
    clock.now += 300;
    await round();
    expect(txs(store)[0]?.status).toBe("reorged");
    expect(gauges.get("arweave_funder_reorged")).toBe(1);
    expect(store.state?.halted?.reason).toMatch(/credited by Turbo, then reorganised out of the chain/);
    clock.now += 300;
    await expect(round()).resolves.toBe("halted");
    expect(chain.sent).toEqual(["0xraw0"]);
  });
});

describe("a receipt a lagging RPC backend has not seen", () => {
  it("is not a reorg while the chain's nonce still covers the transaction", async () => {
    const { chain, bundler, store, round } = setup();
    await round();
    chain.mine("0xhash0");
    bundler.credits = CREDIT;
    clock.now += 300;
    await round();
    chain.receipts.delete("0xhash0");
    for (let i = 0; i < 3; i += 1) {
      clock.now += 300;
      await expect(round()).resolves.toBe("done");
    }
    expect(txs(store)[0]?.status).toBe("credited");
    expect(chain.sent).toEqual(["0xraw0"]);
  });

  it("halts once no transaction it signed has a receipt for a spent nonce, long past any backend's lag", async () => {
    const { chain, bundler, store, round } = setup();
    await round();
    chain.mine("0xhash0");
    bundler.credits = CREDIT;
    clock.now += 300;
    await round();
    chain.receipts.delete("0xhash0");
    clock.now += 300;
    await expect(round()).resolves.toBe("done");
    clock.now += 30 * 60;
    await expect(round()).resolves.toBe("halted");
    expect(store.state?.halted?.reason).toMatch(/nonce 0 was consumed by a transaction this funder did not record, after top-up 0xhash0 landed/);
    expect(chain.sent).toEqual(["0xraw0"]);
  });

  it("is not a reorg when it reappears within the grace period", async () => {
    const { chain, bundler, store, round } = setup();
    await round();
    chain.mine("0xhash0");
    bundler.credits = CREDIT;
    clock.now += 300;
    await round();
    const receipt = chain.receipts.get("0xhash0")!;
    chain.reorg("0xhash0");
    clock.now += 60;
    await round();
    chain.receipts.set("0xhash0", receipt);
    chain.latest += 1;
    clock.now += 300;
    await expect(round()).resolves.toBe("done");
    expect(txs(store)[0]).toMatchObject({ status: "credited" });
    expect(txs(store)[0]?.receiptMissingSince).toBeUndefined();
  });
});

describe("sharing with the upload key", () => {
  it("records a share by its data-item id before asking Turbo, and marks it seen once Turbo answers", async () => {
    const { bundler, store, round } = setup();
    bundler.credits = CREDIT;
    await expect(round()).resolves.toBe("done");
    expect(store.state?.approvals).toEqual([{ at: T0, amount: (CREDIT / 20n).toString(), id: "share-1", seenAt: T0 }]);
  });

  it("takes the record back when Turbo answers that it made no share", async () => {
    const { bundler, store, round } = setup();
    bundler.credits = CREDIT;
    bundler.failNext = { error: new ShareRefused("share credits: Turbo answered HTTP 400"), made: false };
    await expect(round()).rejects.toThrow(/HTTP 400/);
    expect(store.state?.approvals).toEqual([]);
  });

  it("keeps a share whose answer was lost once Turbo lists it, and shares nothing more for it", async () => {
    const { bundler, store, round } = setup();
    bundler.credits = CREDIT;
    bundler.failNext = { error: new Error("share credits: request timed out"), made: true };
    await expect(round()).rejects.toThrow(/timed out/);
    expect(store.state?.approvals).toEqual([{ at: T0, amount: (CREDIT / 20n).toString(), id: "share-1" }]);
    clock.now += 300;
    await expect(round()).resolves.toBe("done");
    expect(store.state?.approvals).toEqual([{ at: T0, amount: (CREDIT / 20n).toString(), id: "share-1", seenAt: clock.now }]);
    clock.now += 30 * 60;
    await expect(round()).resolves.toBe("done");
    expect(store.state?.approvals).toHaveLength(1);
    expect(bundler.signed).toBe(1);
  });

  it("waits out the grace for a share whose answer was lost, then stops counting it and shares again", async () => {
    const { bundler, store, gauges, round } = setup();
    bundler.credits = CREDIT;
    for (let i = 0; i < 2; i += 1) {
      bundler.failNext = { error: new Error("share credits: request timed out"), made: false };
      await expect(round()).rejects.toThrow(/timed out/);
      for (let r = 0; r < 2; r += 1) {
        clock.now += 300;
        await expect(round()).resolves.toBe("done");
        expect(bundler.signed).toBe(i + 1);
      }
      clock.now += 15 * 60;
    }
    await expect(round()).resolves.toBe("done");
    expect(bundler.signed).toBe(3);
    expect(bundler.approvals).toHaveLength(1);
    expect(store.state?.approvals).toEqual([expect.objectContaining({ id: "share-3", seenAt: clock.now })]);
    expect(gauges.get("arweave_funder_approval_cap_reached")).toBe(0);
  });

  it("waits for a top-up instead of failing the round when the spendable credits cannot cover a share", async () => {
    const { bundler, gauges, round } = setup();
    bundler.credits = CREDIT / 40n;
    await expect(round()).resolves.toBe("done");
    expect(bundler.approvals).toEqual([]);
    expect(gauges.get("arweave_funder_share_unfunded")).toBe(1);
  });
});

describe("a replacement whose nonce is already spent", () => {
  it("settles the group from the receipt it has instead of failing every round on the broadcast", async () => {
    const { chain, bundler, store, signer, round } = setup();
    await round();
    clock.now += 901;
    const send = chain.send.bind(chain);
    chain.send = async (raw: string) => {
      if (raw === "0xraw1") {
        chain.mine("0xhash0");
        throw new Error("eth_sendRawTransaction: nonce too low (-32000)");
      }
      return send(raw);
    };
    await expect(round()).resolves.toBe("done");
    expect(signer.signed.map((t) => t.nonce)).toEqual([0, 0]);
    bundler.credits = CREDIT;
    clock.now += 300;
    await expect(round()).resolves.toBe("done");
    expect(txs(store).map((t) => t.status)).toEqual(["credited", "dropped"]);
  });

  it("keeps the round going, share renewal included, when a signed top-up cannot be broadcast", async () => {
    const { chain, bundler, store, round } = setup();
    store.state = {
      schema: 2,
      nextNonce: 1,
      txs: [{ nonce: 0, hash: "0xh", raw: "0xstale", value: "1", maxFeePerGas: "1", maxPriorityFeePerGas: "1", status: "signed", createdAt: T0, updatedAt: T0 }],
      approvals: [],
    };
    chain.send = async () => {
      throw new Error("eth_sendRawTransaction: replacement transaction underpriced (-32000)");
    };
    bundler.credits = CREDIT / 20n;
    await expect(round()).resolves.toBe("done");
    expect(txs(store)[0]?.status).toBe("signed");
    expect(bundler.approvals).toHaveLength(1);
  });
});

describe("a reorganisation that lands a different transaction of the same nonce", () => {
  it("takes the replacement as the landed top-up and offers its hash to Turbo", async () => {
    const { chain, bundler, store, round } = setup();
    await round();
    clock.now += 901;
    await round();
    chain.mine("0xhash0");
    bundler.credit = "pending";
    clock.now += 60;
    await round();
    expect(txs(store).map((t) => t.status)).toEqual(["mined", "dropped"]);
    chain.receipts.delete("0xhash0");
    chain.receipts.set("0xhash1", { status: 1, blockNumber: 102, feeWei: 1n });
    bundler.credit = "credited";
    bundler.credits = CREDIT;
    clock.now += 60;
    await round();
    expect(txs(store).map((t) => t.status)).toEqual(["dropped", "credited"]);
    expect(bundler.submitted.at(-1)).toBe("0xhash1");
  });

  it("halts when Turbo had already credited the transaction the chain replaced", async () => {
    const { chain, bundler, store, round } = setup();
    await round();
    clock.now += 901;
    await round();
    chain.mine("0xhash0");
    bundler.credits = CREDIT;
    clock.now += 60;
    await round();
    expect(txs(store)[0]?.status).toBe("credited");
    chain.receipts.delete("0xhash0");
    chain.receipts.set("0xhash1", { status: 1, blockNumber: 102, feeWei: 1n });
    clock.now += 60;
    await expect(round()).resolves.toBe("halted");
    expect(store.state?.halted?.reason).toMatch(/credited by Turbo, then replaced on chain by 0xhash1/);
  });
});

describe("Turbo not answering for a mined top-up", () => {
  it("does not stop the round from sharing credits", async () => {
    const { chain, bundler, round } = setup();
    await round();
    chain.mine("0xhash0");
    bundler.submitFundTransaction = async () => {
      throw new Error("submit fund transaction: Turbo answered HTTP 500");
    };
    bundler.credits = CREDIT / 20n;
    clock.now += 300;
    await expect(round()).resolves.toBe("done");
    expect(bundler.approvals).toHaveLength(1);
  });
});

describe("Base's L1 data fee", () => {
  it("does not top up when the wallet covers the transfer and its L2 gas but not the L1 fee as well", async () => {
    const { chain, round } = setup();
    chain.l1Fee = GWEI * 1000n;
    chain.wei = ETH / 5n + 21_000n * 2n * GWEI + GWEI * 1000n;
    await round();
    expect(chain.sent).toEqual([]);
    chain.wei = ETH / 5n + 21_000n * 2n * GWEI + GWEI * 1500n;
    clock.now += 300;
    await round();
    expect(chain.sent).toEqual(["0xraw0"]);
  });

  it("ignores it on a chain that charges none", async () => {
    const { chain, round } = setup({ l1DataFee: false });
    chain.l1Fee = ETH;
    chain.wei = ETH / 5n + 21_000n * 2n * GWEI;
    await round();
    expect(chain.sent).toEqual(["0xraw0"]);
  });
});

describe("credits shared with the upload key", () => {
  it("creates one when there is none, for the configured amount and lifetime", async () => {
    const { bundler, round } = setup();
    bundler.credits = CREDIT;
    await round();
    expect(bundler.approvals).toEqual([{ amount: CREDIT / 20n, ttl: 7 * 86_400 }]);
  });

  it("renews it a day before it expires", async () => {
    const { bundler, round } = setup();
    bundler.credits = CREDIT;
    await round();
    clock.now += 6 * 86_400 - 60;
    await round();
    expect(bundler.approvals).toHaveLength(1);
    clock.now += 120;
    await round();
    expect(bundler.approvals).toHaveLength(2);
  });

  it("renews early once when it runs low, and refuses a second early renewal in the same window", async () => {
    const { bundler, gauges, round } = setup();
    bundler.credits = CREDIT;
    await round();
    bundler.sharedAmount = 1n; // spent within hours
    clock.now += 3600;
    await round();
    expect(bundler.approvals).toHaveLength(2);
    bundler.sharedAmount = 1n;
    clock.now += 3600;
    await round();
    expect(bundler.approvals).toHaveLength(2);
    expect(gauges.get("arweave_funder_approval_cap_reached")).toBe(1);
  });
});

describe("one funder at a time", () => {
  it("skips the round while another holder's lease is live, and takes over once it lapses", async () => {
    const { chain, store, round } = setup();
    store.state = { schema: 2, nextNonce: 0, txs: [], approvals: [], lease: { holder: "other", until: T0 + 100 } };
    store.version = 1;
    await expect(round()).resolves.toBe("lease-held");
    expect(chain.sent).toEqual([]);
    clock.now += 101;
    await expect(round()).resolves.toBe("done");
    expect(store.state?.lease?.holder).toBe("me");
  });

  it("abandons the round when another writer got in first", async () => {
    const { chain, store, round } = setup();
    store.stealNext = true;
    await expect(round()).resolves.toBe("conflict");
    expect(chain.sent).toEqual([]);
  });
});
