import { useState } from "react";
import type { Network } from "soroban-verification-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PillIcon } from "@/components/ui/pill-icon";
import { contractFailureCopy, useContractLookup } from "../hooks/use-contract-lookup";
import { LookupResult } from "./LookupResult";

const NETWORKS: Network[] = ["mainnet", "testnet"];

/** Look up whatever Wasm a contract address currently holds, across every trusted verifier. */
export const ContractLookup = () => {
  const [network, setNetwork] = useState<Network>("testnet");
  const [input, setInput] = useState("");
  const [submitted, setSubmitted] = useState<string | null>(null);
  const state = useContractLookup(network, submitted);

  return (
    <div>
      <form
        className="flex flex-wrap items-center gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          setSubmitted(input.trim());
          state.refresh();
        }}
      >
        <select
          aria-label="Network"
          value={network}
          onChange={(event) => {
            setNetwork(event.target.value as Network);
            setSubmitted(null);
          }}
          data-testid="contract-network"
          className="h-11 rounded-md border border-line-strong bg-surface px-3 font-mono text-[0.85rem] text-ink focus:shadow-focus focus-visible:outline-none"
        >
          {NETWORKS.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
        <Input
          aria-label="Contract address"
          placeholder="C… (56-character contract address)"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          className="max-w-[34rem] font-mono"
        />
        <Button type="submit">
          Look up
          <PillIcon animated>→</PillIcon>
        </Button>
      </form>

      <div className="mt-8">
        <LookupResult
          state={state}
          testIdPrefix="contract"
          invalidCopy="A contract address is `C` followed by 55 characters. Nothing was queried."
          loadingCopy="Resolving the address, then asking…"
          failureCopy={contractFailureCopy}
        />
      </div>
    </div>
  );
};
