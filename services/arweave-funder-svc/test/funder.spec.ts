import { FunderRound, type Chain, type FunderSettings, type FunderState, type FundTx, type Irys, type StateStore, type TxSigner } from "../src/funder.js";

const FUNDER = "0x00000000000000000000000000000000000000f0";
const DEPOSIT = "0x00000000000000000000000000000000000000d0";
const UPLOADER = "0x00000000000000000000000000000000000000a0";
const ETH = 10n ** 18n;
const GWEI = 10n ** 9n;
const T0 = 1_800_000_000;

const SETTINGS: FunderSettings = {
  chainId: 84532,
  depositAddress: DEPOSIT,
  approvedAddress: UPLOADER,
  irysLowWei: ETH / 10n,
  topUpWei: ETH / 5n,
  dailyTopUpCapWei: ETH / 2n,
  maxFeePerGasWei: 10n * GWEI,
  maxGasLimit: 60_000n,
  stuckAfterSeconds: 900,
  approvalWei: ETH / 20n,
  approvalTtlSeconds: 7 * 86_400,
  approvalRenewBeforeSeconds: 86_400,
  approvalWindowCapWei: ETH / 10n,
  leaseSeconds: 900,
  holder: "me",
};

class FakeChain implements Chain {
  id = 84532;
  latest = 0;
  wei = 5n * ETH;
  fee = { maxFeePerGas: 2n * GWEI, maxPriorityFeePerGas: GWEI / 1000n };
  sent: string[] = [];
  receipts = new Map<string, 0 | 1>();
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
  async estimateGas() {
    return 21_000n;
  }
  async send(raw: string) {
    this.sent.push(raw);
  }
  async receipt(hash: string) {
    const status = this.receipts.get(hash);
    return status === undefined ? undefined : { status };
  }
  mine(hash: string, status: 0 | 1 = 1) {
    this.receipts.set(hash, status);
    this.latest += 1;
  }
}

class FakeIrys implements Irys {
  deposit = DEPOSIT;
  irysBalance = 0n;
  approvalAmount = 0n;
  approvalExpiresAt: number | undefined;
  approvals: { amount: bigint; ttl: number }[] = [];
  submitted: string[] = [];
  credit: "credited" | "pending" = "credited";
  async depositAddress() {
    return this.deposit;
  }
  async balance() {
    return this.irysBalance;
  }
  async approval() {
    return { amount: this.approvalAmount, ...(this.approvalExpiresAt === undefined ? {} : { expiresAt: this.approvalExpiresAt }) };
  }
  async createApproval(_approved: string, amount: bigint, ttl: number) {
    this.approvals.push({ amount, ttl });
    this.approvalAmount = amount;
    this.approvalExpiresAt = clock.now + ttl;
    return `approval-${this.approvals.length}`;
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
  const irys = new FakeIrys();
  const store = new FakeStore();
  const signer = new FakeSigner();
  const events: { level: string; msg: string }[] = [];
  const gauges = new Map<string, number>();
  const round = (holder = "me") =>
    new FunderRound(
      { ...SETTINGS, ...overrides, holder },
      {
        chain,
        irys,
        store,
        signer,
        telemetry: { gauge: (n, v) => gauges.set(n, v), event: (level, msg) => events.push({ level, msg }) },
        now: () => clock.now * 1000,
      },
    ).run();
  return { chain, irys, store, signer, events, gauges, round };
}

const txs = (store: FakeStore): FundTx[] => store.state?.txs ?? [];

beforeEach(() => {
  clock.now = T0;
});

describe("topping up", () => {
  it("records the signed transaction before broadcasting it, then credits it once mined", async () => {
    const { chain, irys, store, round } = setup();

    await expect(round()).resolves.toBe("done");
    expect(chain.sent).toEqual(["0xraw0"]);
    expect(txs(store)).toMatchObject([{ nonce: 0, hash: "0xhash0", status: "broadcast", value: (ETH / 5n).toString() }]);
    expect(store.state?.nextNonce).toBe(1);

    chain.mine("0xhash0");
    clock.now += 300;
    await round();
    expect(irys.submitted).toEqual(["0xhash0"]);
    expect(txs(store)[0]?.status).toBe("credited");
  });

  it("does nothing while the Irys balance is above the low-water mark", async () => {
    const { chain, irys, round } = setup();
    irys.irysBalance = ETH;
    await round();
    expect(chain.sent).toEqual([]);
  });

  it("keeps retrying the credit with the same hash, and never sends a second transfer for it", async () => {
    const { chain, irys, store, round } = setup();
    await round();
    chain.mine("0xhash0");
    irys.credit = "pending";
    for (let i = 0; i < 3; i += 1) {
      clock.now += 300;
      await round();
    }
    expect(irys.submitted).toEqual(["0xhash0", "0xhash0", "0xhash0"]);
    expect(chain.sent).toEqual(["0xraw0"]);
    expect(txs(store)[0]?.status).toBe("mined");
  });

  it("re-sends the recorded bytes when it stopped between signing and broadcasting", async () => {
    const { chain, store, round, signer } = setup();
    store.state = {
      schema: 1,
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
    const { chain, irys, gauges, round } = setup({ dailyTopUpCapWei: ETH / 4n });
    await round();
    chain.mine("0xhash0");
    clock.now += 300;
    await round();
    irys.irysBalance = 0n;
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

  it("refuses to sign for a different chain", async () => {
    const { chain, round } = setup();
    chain.id = 1;
    await expect(round()).rejects.toThrow(/chain 1, configured for 84532/);
    expect(chain.sent).toEqual([]);
  });
});

describe("halting", () => {
  it("halts, and stays halted, when Irys reports a deposit address other than the configured one", async () => {
    const { chain, irys, store, round } = setup();
    irys.deposit = "0x00000000000000000000000000000000000000ee";
    await expect(round()).resolves.toBe("halted");
    expect(store.state?.halted?.reason).toMatch(/deposit address/);
    irys.deposit = DEPOSIT;
    await expect(round()).resolves.toBe("halted");
    expect(chain.sent).toEqual([]);
  });

  it("halts when the chain shows a transfer this funder did not record", async () => {
    const { chain, irys, store, round, gauges } = setup();
    await round();
    chain.mine("0xhash0");
    irys.irysBalance = ETH;
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
    const { chain, irys, signer, store, round } = setup();
    await round();
    clock.now += 901;
    await round();
    expect(signer.signed.map((s) => s.nonce)).toEqual([0, 0]);
    expect(BigInt(signer.signed[1]!.maxFeePerGas)).toBeGreaterThanOrEqual((BigInt(signer.signed[0]!.maxFeePerGas) * 1125n) / 1000n);
    expect(chain.sent).toEqual(["0xraw0", "0xraw1"]);

    chain.mine("0xhash1");
    irys.irysBalance = ETH;
    clock.now += 60;
    await round();
    expect(txs(store).map((t) => t.status)).toEqual(["dropped", "credited"]);
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

describe("the upload key's approval", () => {
  it("creates one when there is none, for the configured amount and lifetime", async () => {
    const { irys, round } = setup();
    irys.irysBalance = ETH;
    await round();
    expect(irys.approvals).toEqual([{ amount: ETH / 20n, ttl: 7 * 86_400 }]);
  });

  it("renews it a day before it expires", async () => {
    const { irys, round } = setup();
    irys.irysBalance = ETH;
    await round();
    clock.now += 6 * 86_400 - 60;
    await round();
    expect(irys.approvals).toHaveLength(1);
    clock.now += 120;
    await round();
    expect(irys.approvals).toHaveLength(2);
  });

  it("renews early once when it runs low, and refuses a second early renewal in the same window", async () => {
    const { irys, gauges, round } = setup();
    irys.irysBalance = ETH;
    await round();
    irys.approvalAmount = 1n; // spent within hours
    clock.now += 3600;
    await round();
    expect(irys.approvals).toHaveLength(2);
    irys.approvalAmount = 1n;
    clock.now += 3600;
    await round();
    expect(irys.approvals).toHaveLength(2);
    expect(gauges.get("arweave_funder_approval_cap_reached")).toBe(1);
  });
});

describe("one funder at a time", () => {
  it("skips the round while another holder's lease is live, and takes over once it lapses", async () => {
    const { chain, store, round } = setup();
    store.state = { schema: 1, nextNonce: 0, txs: [], approvals: [], lease: { holder: "other", until: T0 + 100 } };
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
