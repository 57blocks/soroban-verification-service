import { Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Address, StrKey, xdr } from "@stellar/stellar-base";
import type { Network } from "@scvs/core";
import { MalformedContractIdError, type AddressResolver } from "./address-resolver.js";
import type { AppConfigService } from "../../config/configuration.js";

const FIRST_ENTRY = 0;

@Injectable()
export class StellarRpcAddressResolver implements AddressResolver {
  constructor(@Inject(ConfigService) private readonly configService: AppConfigService) {}

  async resolve(network: Network, contractId: string): Promise<string | undefined> {
    // Validate first: an `Address` parse failure would otherwise surface as a ledger failure.
    if (!StrKey.isValidContract(contractId)) throw new MalformedContractIdError(contractId);

    const endpoint = this.endpointFor(network);
    const key = instanceKey(contractId);

    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getLedgerEntries",
        params: { keys: [key.toXDR("base64")] },
      }),
      signal: AbortSignal.timeout(this.configService.get("rpcTimeoutMs", { infer: true })),
    });
    if (!response.ok) throw new Error(`Soroban RPC ${endpoint} answered ${response.status}`);

    const body = (await response.json()) as { result?: { entries?: Array<{ xdr: string }> }; error?: { message?: string } };
    if (body.error) throw new Error(`Soroban RPC error: ${body.error.message ?? "unknown"}`);

    const raw = body.result?.entries?.[FIRST_ENTRY]?.xdr;
    if (raw === undefined) return undefined;

    const executable = xdr.LedgerEntryData.fromXDR(raw, "base64").contractData().val().instance().executable();
    return executable.switch() === xdr.ContractExecutableType.contractExecutableWasm()
      ? executable.wasmHash().toString("hex")
      : undefined;
  }

  private endpointFor(network: Network): string {
    const endpoint =
      network === "mainnet"
        ? this.configService.get("stellarRpcUrlMainnet", { infer: true })
        : this.configService.get("stellarRpcUrlTestnet", { infer: true });
    if (!endpoint) {
      throw new Error(`No Soroban RPC endpoint configured for ${network}`);
    }
    return endpoint;
  }
}

function instanceKey(contractId: string): xdr.LedgerKey {
  return xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: new Address(contractId).toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
    }),
  );
}
