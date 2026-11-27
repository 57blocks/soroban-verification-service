import { remainingShare, S3StateStore } from "../src/adapters.js";

function storeHolding(text: string) {
  const s3 = {
    send: async () => ({ Body: { transformToString: async () => text }, ETag: '"v1"' }),
  };
  return new S3StateStore(s3 as never, "bucket", "arweave-funder/state.json");
}

describe("the funder's state object", () => {
  const irysTx = (nonce: number, status: string) => ({
    nonce,
    hash: `0xh${nonce}`,
    raw: "0xr",
    value: "1",
    maxFeePerGas: "1",
    maxPriorityFeePerGas: "1",
    status,
    createdAt: 1,
    updatedAt: 1,
  });

  it("carries a schema-1 state over, dropping its Irys approvals and settling a mined Irys transfer as refused", async () => {
    const legacy = {
      schema: 1,
      nextNonce: 3,
      halted: { reason: "x", at: 1 },
      txs: [irysTx(1, "credited"), irysTx(2, "mined")],
      approvals: [{ at: 1, amount: "5000000000000000" }],
    };
    const { state } = await storeHolding(JSON.stringify(legacy)).load();
    expect(state).toMatchObject({ schema: 2, nextNonce: 3, halted: legacy.halted, approvals: [] });
    expect(state?.txs[0]).toEqual(irysTx(1, "credited"));
    expect(state?.txs[1]).toMatchObject({ status: "rejected", confirmedAt: expect.any(Number) });
  });

  it("refuses a schema-1 state with an Irys transfer still in flight", async () => {
    const legacy = { schema: 1, nextNonce: 3, txs: [irysTx(2, "broadcast")], approvals: [] };
    await expect(storeHolding(JSON.stringify(legacy)).load()).rejects.toThrow(/Irys-era state with top-up 0xh2 \(nonce 2\) still broadcast/);
  });

  it("refuses a schema it does not know", async () => {
    await expect(storeHolding(JSON.stringify({ schema: 9, nextNonce: 0, txs: [], approvals: [] })).load()).rejects.toThrow(/schema 9, expected 2/);
  });
});

describe("credits shared with the upload key", () => {
  const share = (approvedAddress: string, approved: string, used: string, expirationDate?: string, approvalDataItemId?: string) => ({
    approvalDataItemId,
    approvedAddress,
    approvedWincAmount: approved,
    usedWincAmount: used,
    expirationDate,
  });
  const NOW = Date.parse("2026-11-26T00:00:00Z");

  it("sums what is left of every live share to that address, and reports when the last one lapses", () => {
    const result = remainingShare(
      [
        share("0xAA", "100", "40", "2026-11-27T00:00:00Z", "item-1"),
        share("0xaa", "50", "0", "2026-12-01T00:00:00Z", "item-2"),
        share("0xbb", "999", "0", "2026-12-01T00:00:00Z"),
        share("0xaa", "70", "0", "2026-11-25T00:00:00Z"),
      ],
      "0xaa",
      NOW,
    );
    expect(result).toEqual({ amount: 110n, expiresAt: Date.parse("2026-12-01T00:00:00Z") / 1000, ids: ["item-1", "item-2"] });
  });

  it("reports nothing shared when every share has lapsed", () => {
    expect(remainingShare([share("0xaa", "10", "0", "2026-11-01T00:00:00Z")], "0xaa", NOW)).toEqual({ amount: 0n, ids: [] });
  });
});
