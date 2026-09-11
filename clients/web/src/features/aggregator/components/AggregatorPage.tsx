import { useState } from "react";
import { cn } from "@/lib/utils";
import { useAdditionalRoots } from "../hooks/use-additional-roots";
import { useTrustedVerifiers } from "../hooks/use-trusted-verifiers";
import { AdditionalRootsPanel } from "./AdditionalRootsPanel";
import { CollapsibleSection } from "./CollapsibleSection";
import { ContractLookup } from "./ContractLookup";
import { HashLookup } from "./HashLookup";
import { TrustedVerifiers } from "./TrustedVerifiers";

const TABS = [
  { id: "hash", label: "By Wasm hash" },
  { id: "contract", label: "By contract ID" },
] as const;

type TabId = (typeof TABS)[number]["id"];

/** The aggregator: what the verifiers this deployment trusts say about one subject. */
export const AggregatorPage = () => {
  const [active, setActive] = useState<TabId>("hash");
  const { list, isLoading, failure } = useTrustedVerifiers();
  const { roots, add, remove } = useAdditionalRoots();

  return (
    <main className="relative min-h-screen bg-surface-alt font-sans leading-normal text-ink antialiased">
      <div className="mx-auto max-w-console px-8 pb-16 pt-14">
        <h1 className="m-0 font-display text-[2rem] font-semibold">Aggregated Verification Results</h1>
        <p className="mb-0 mt-2 max-w-[64ch] text-[0.95rem] leading-relaxed text-ink-muted">
          What the verifiers this deployment trusts say about a Wasm hash or a deployed contract.
          Answers come from the aggregate it retained, so a slow verifier never holds up a page — and
          an answer reflects the last successful sync rather than this instant.
        </p>

        <div className="mt-8 space-y-3">
          <CollapsibleSection
            title="Trusted verifiers"
            // Undefined, not 0, whenever the number is unknown — a failed read is exactly that, and a collapsed
            // section showing 0 claims this deployment aggregates across nobody.
            count={isLoading || failure ? undefined : list?.verifiers?.length}
            testId="tvl-section"
          >
            <TrustedVerifiers />
          </CollapsibleSection>

          <CollapsibleSection
            title="Additional result roots"
            count={roots.length}
            testId="roots-section"
          >
            <AdditionalRootsPanel roots={roots} onAdd={add} onRemove={remove} />
          </CollapsibleSection>
        </div>

        <nav className="mt-10 flex flex-wrap gap-2" aria-label="Lookup by">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActive(tab.id)}
              aria-current={tab.id === active ? "true" : undefined}
              data-testid={`query-tab-${tab.id}`}
              className={cn(
                "rounded-full border px-4 py-2 text-[0.85rem] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yellow",
                tab.id === active
                  ? "border-ink bg-ink font-medium text-surface"
                  : "border-line bg-surface text-ink-muted hover:text-ink",
              )}
            >
              {tab.label}
            </button>
          ))}
        </nav>

        <div className="mt-8">
          {/* Both stay mounted: switching tabs must not throw away a typed subject or its answer,
              and the contract tab's lookup includes a ledger read worth not repeating. */}
          <div hidden={active !== "hash"} data-testid="tab-panel-hash">
            <HashLookup additionalRoots={roots} />
          </div>
          <div hidden={active !== "contract"} data-testid="tab-panel-contract">
            <ContractLookup />
          </div>
        </div>
      </div>
    </main>
  );
};
