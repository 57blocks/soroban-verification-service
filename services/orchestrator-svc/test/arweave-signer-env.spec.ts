import { createEnvValidator } from "@scvs/core";
import { OrchestratorSvcEnvDto } from "../src/config/env.dto.js";

const validate = createEnvValidator(OrchestratorSvcEnvDto, "orchestrator-svc");

const BASE = { SCVS_STORAGE_BUCKET: "stellar-scratch" };
const IRYS = { ...BASE, SCVS_ARWEAVE_MODE: "irys" };
const KEY_ID = "arn:aws:kms:ap-southeast-2:000000000000:alias/scvs-nonprod-arweave-signer";
const PAYER = `0x${"aB".repeat(20)}`;
const KMS = { SCVS_ARWEAVE_SIGNER: "kms", SCVS_ARWEAVE_KMS_KEY_ID: KEY_ID, SCVS_ARWEAVE_PAID_BY: PAYER };

describe("Arweave signer environment", () => {
  it("leaves the private-key signer as the default off mainnet", () => {
    expect(() => validate({ ...IRYS, SCVS_ARWEAVE_WALLET_PRIVATE_KEY: "0xabc" })).not.toThrow();
    expect(() => validate({ ...IRYS, SCVS_ARWEAVE_NETWORK: "devnet", SCVS_ARWEAVE_SIGNER: "private-key" })).not.toThrow();
  });

  it("rejects a signer no code implements", () => {
    expect(() => validate({ ...IRYS, SCVS_ARWEAVE_SIGNER: "hsm" })).toThrow(/SCVS_ARWEAVE_SIGNER must be one of: kms, private-key/);
  });

  it("requires a key id for the kms signer", () => {
    expect(() => validate({ ...IRYS, ...KMS, SCVS_ARWEAVE_KMS_KEY_ID: undefined })).toThrow(/SCVS_ARWEAVE_KMS_KEY_ID is required/);
    expect(() => validate({ ...IRYS, ...KMS, SCVS_ARWEAVE_KMS_KEY_ID: "" })).toThrow(/SCVS_ARWEAVE_KMS_KEY_ID is required/);
    expect(() => validate({ ...IRYS, ...KMS })).not.toThrow();
  });

  it("requires a paying wallet for the kms signer, whose address cannot hold a balance of its own", () => {
    expect(() => validate({ ...IRYS, ...KMS, SCVS_ARWEAVE_PAID_BY: undefined })).toThrow(/SCVS_ARWEAVE_PAID_BY is required/);
    expect(() => validate({ ...IRYS, ...KMS, SCVS_ARWEAVE_PAID_BY: "" })).toThrow(/SCVS_ARWEAVE_PAID_BY is required/);
    expect(() => validate({ ...IRYS, SCVS_ARWEAVE_NETWORK: "devnet", ...KMS, SCVS_ARWEAVE_PAID_BY: undefined })).toThrow(
      /SCVS_ARWEAVE_PAID_BY is required/,
    );
  });

  it("leaves the paying wallet optional for the private-key signer", () => {
    expect(() => validate({ ...IRYS, SCVS_ARWEAVE_SIGNER: "private-key" })).not.toThrow();
  });

  it("accepts a paying wallet only as an Ethereum address", () => {
    expect(() => validate({ ...IRYS, SCVS_ARWEAVE_PAID_BY: PAYER })).not.toThrow();
    expect(() => validate({ ...IRYS, SCVS_ARWEAVE_PAID_BY: "aB".repeat(20) })).toThrow(/SCVS_ARWEAVE_PAID_BY must be/);
    expect(() => validate({ ...IRYS, SCVS_ARWEAVE_PAID_BY: "0x1234" })).toThrow(/SCVS_ARWEAVE_PAID_BY must be/);
  });

  it("does not ask for a key id while archiving is off", () => {
    expect(() => validate({ ...BASE, SCVS_ARWEAVE_SIGNER: "kms" })).not.toThrow();
  });

  describe("on Irys mainnet", () => {
    const MAINNET = { ...IRYS, SCVS_ARWEAVE_NETWORK: "mainnet", SCVS_ARWEAVE_RPC_URL: "https://rpc.example" };

    it("refuses the private-key signer, set or defaulted", () => {
      expect(() => validate({ ...MAINNET, SCVS_ARWEAVE_SIGNER: "private-key" })).toThrow(/must be kms/);
      expect(() => validate({ ...MAINNET, SCVS_ARWEAVE_WALLET_PRIVATE_KEY: "0xabc" })).toThrow(/SCVS_ARWEAVE_SIGNER/);
    });

    it("accepts the kms signer with a key id", () => {
      expect(() => validate({ ...MAINNET, ...KMS })).not.toThrow();
    });

    it("refuses the kms signer without a paying wallet", () => {
      expect(() => validate({ ...MAINNET, ...KMS, SCVS_ARWEAVE_PAID_BY: undefined })).toThrow(/SCVS_ARWEAVE_PAID_BY is required/);
    });

    it("does not apply while archiving is off", () => {
      expect(() => validate({ ...BASE, SCVS_ARWEAVE_NETWORK: "mainnet" })).not.toThrow();
    });
  });
});
