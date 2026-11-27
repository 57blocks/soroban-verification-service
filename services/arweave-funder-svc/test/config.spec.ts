import { loadFunderConfig } from "../src/config.js";

const ENV = {
  SCVS_ARWEAVE_NETWORK: "devnet",
  SCVS_ARWEAVE_TOKEN: "base-eth",
  SCVS_FUNDER_KMS_KEY_ID: "arn:aws:kms:ap-southeast-2:000000000000:key/11111111-2222-3333-4444-555555555555",
  SCVS_FUNDER_APPROVED_ADDRESS: "0x85F0CF63199C798F163BB81A32ED6A426C5919A6",
  SCVS_FUNDER_RPC_URL: "https://sepolia.base.org",
  SCVS_FUNDER_CHAIN_ID: "84532",
  SCVS_FUNDER_DEPOSIT_ADDRESS: "0x00000000000000000000000000000000000000D0",
  SCVS_FUNDER_STATE_BUCKET: "example-funder-state",
  SCVS_FUNDER_CREDITS_LOW_WINC: "100000000000",
  SCVS_FUNDER_TOPUP_WEI: "20000000000000000",
  SCVS_FUNDER_DAILY_TOPUP_CAP_WEI: "50000000000000000",
  SCVS_FUNDER_MAX_FEE_PER_GAS_WEI: "5000000000",
  SCVS_FUNDER_SHARE_WINC: "50000000000",
};

describe("funder configuration", () => {
  it("loads a complete environment, lowercasing addresses and defaulting the rest", () => {
    const config = loadFunderConfig(ENV);
    expect(config.token).toBe("base-eth");
    expect(config.turbo).toEqual({ uploadUrl: "https://upload.services.ar-io.dev", paymentUrl: "https://payment.services.ar-io.dev" });
    expect(config.settings.approvedAddress).toBe("0x85f0cf63199c798f163bb81a32ed6a426c5919a6");
    expect(config.settings.depositAddress).toBe("0x00000000000000000000000000000000000000d0");
    expect(config.stateKey).toBe("arweave-funder/state.json");
    expect(config.intervalMs).toBe(300_000);
    expect(config.settings.shareTtlSeconds).toBe(7 * 86_400);
    expect(config.settings.shareWindowCapWinc).toBe(100_000_000_000n);
    expect(config.settings.leaseSeconds).toBe(900);
  });

  it("points mainnet at Turbo's production services", () => {
    expect(loadFunderConfig({ ...ENV, SCVS_ARWEAVE_NETWORK: "mainnet", SCVS_FUNDER_CHAIN_ID: "8453" }).turbo).toEqual({
      uploadUrl: "https://upload.ardrive.io",
      paymentUrl: "https://payment.ardrive.io",
    });
  });

  it.each([
    ["an alias instead of a key ARN", { SCVS_FUNDER_KMS_KEY_ID: "arn:aws:kms:ap-southeast-2:000000000000:alias/x" }, /SCVS_FUNDER_KMS_KEY_ID must be a KMS key ARN/],
    ["a token the funder does not buy credits in", { SCVS_ARWEAVE_TOKEN: "matic" }, /SCVS_ARWEAVE_TOKEN must be one of/],
    ["a missing deposit address", { SCVS_FUNDER_DEPOSIT_ADDRESS: undefined }, /SCVS_FUNDER_DEPOSIT_ADDRESS/],
    ["a daily cap below one top-up", { SCVS_FUNDER_DAILY_TOPUP_CAP_WEI: "1" }, /must be at least SCVS_FUNDER_TOPUP_WEI/],
    ["a window cap below one share", { SCVS_FUNDER_SHARE_WINDOW_CAP_WINC: "1" }, /must be at least SCVS_FUNDER_SHARE_WINC/],
    ["mainnet credits bought on a testnet", { SCVS_ARWEAVE_NETWORK: "mainnet" }, /SCVS_FUNDER_CHAIN_ID must be 8453 for SCVS_ARWEAVE_TOKEN base-eth on SCVS_ARWEAVE_NETWORK mainnet/],
    ["sandbox credits bought with real ETH", { SCVS_FUNDER_CHAIN_ID: "8453" }, /SCVS_FUNDER_CHAIN_ID must be 84532 for SCVS_ARWEAVE_TOKEN base-eth on SCVS_ARWEAVE_NETWORK devnet/],
    ["a chain of the other token", { SCVS_ARWEAVE_TOKEN: "ethereum" }, /SCVS_FUNDER_CHAIN_ID must be 11155111 or 17000/],
    ["a fractional amount", { SCVS_FUNDER_TOPUP_WEI: "0.5" }, /SCVS_FUNDER_TOPUP_WEI must be a positive integer number of wei/],
  ])("rejects %s", (_label, change, message) => {
    expect(() => loadFunderConfig({ ...ENV, ...change })).toThrow(message);
  });
});
