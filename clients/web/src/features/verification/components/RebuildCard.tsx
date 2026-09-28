import { ExternalLink } from "lucide-react";
import { SealedBox } from "@/components/sealed-box";
import { cn } from "@/lib/utils";
import { ValueStrip } from "./ValueStrip";
import type {
  ProvenanceField,
  RebuildInputs,
} from "../utils/rebuild-provenance.util";

const FieldValue = ({ field }: { field: ProvenanceField }) => {
  const className = "break-all";
  if (!field.href) return <span className={className}>{field.value}</span>;

  return (
    <a
      href={field.href}
      target="_blank"
      rel="noreferrer noopener"
      className={cn(
        className,
        "inline-flex items-start gap-1.5 underline decoration-ink/25 underline-offset-[3px] transition-colors hover:decoration-ink"
      )}
    >
      {field.value}
      <ExternalLink size={12} aria-hidden className="mt-0.5 shrink-0" />
    </a>
  );
};

const OnChainTag = () => (
  <span
    title="Read from the contract's on-chain contractmetav0 — a submitter cannot choose it."
    className="ml-2 rounded-[4px] bg-yellow-soft px-1.5 py-px normal-case tracking-normal text-ink"
  >
    on-chain
  </span>
);

type RebuildCardProps = {
  inputs: RebuildInputs | null;
};

export const RebuildCard = ({ inputs }: RebuildCardProps) => {
  if (!inputs) return null;

  return (
    <section data-testid="rebuild-provenance">
      <SealedBox label="sealed rebuild" className="px-6 pb-6 pt-7 shadow-panel">
        <h2 className="m-0 mb-1 text-[1.35rem] font-semibold">
          How this was rebuilt
        </h2>
        <p className="m-0 mb-5 text-[0.85rem] leading-[1.5] text-ink/[0.66]">
          {inputs.origin}
        </p>

        <div className="grid gap-3 md:grid-cols-2">
          {inputs.fields.map((field) => (
            <ValueStrip
              key={field.key}
              label={
                <>
                  {field.label}
                  {field.onChain && <OnChainTag />}
                </>
              }
              value={<FieldValue field={field} />}
            />
          ))}
        </div>
      </SealedBox>
    </section>
  );
};
