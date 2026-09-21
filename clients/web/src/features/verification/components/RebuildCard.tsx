import { ExternalLink } from "lucide-react";
import { SealedBox } from "@/components/sealed-box";
import { cn } from "@/lib/utils";
import { MonoLabel } from "./MonoLabel";
import { ValueStrip } from "./ValueStrip";
import type {
  ProvenanceField,
  ProvenanceGroup,
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

type RebuildCardProps = {
  groups: ProvenanceGroup[];
};

/**
 * How this contract was rebuilt, grouped by who chose each value — see `rebuildProvenance`. Drawn as the
 * landing page's sealed box, because these are the inputs a rebuild inside that sandbox actually ran on.
 */
export const RebuildCard = ({ groups }: RebuildCardProps) => {
  if (!groups.length) return null;

  return (
    <section data-testid="rebuild-provenance">
      <SealedBox label="sealed rebuild" className="px-6 pb-6 pt-7 shadow-panel">
        <h2 className="m-0 mb-1 text-[1.35rem] font-semibold">
          How this was rebuilt
        </h2>
        <p className="m-0 mb-5 text-[0.85rem] leading-[1.5] text-ink/[0.66]">
          Grouped by who chose each value.
        </p>

        <div className="space-y-5">
          {groups.map((group) => (
            <div key={group.key} data-testid={`provenance-${group.key}`}>
              <MonoLabel className="text-ink-label">{group.title}</MonoLabel>
              <p className="m-0 mb-3 mt-1 text-[0.78rem] leading-[1.45] text-ink/[0.6]">
                {group.origin}
              </p>
              <div className="grid gap-3 md:grid-cols-2">
                {group.fields.map((field) => (
                  <ValueStrip
                    key={field.key}
                    label={field.label}
                    value={<FieldValue field={field} />}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      </SealedBox>
    </section>
  );
};
