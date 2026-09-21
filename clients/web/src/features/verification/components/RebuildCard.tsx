import { ExternalLink } from "lucide-react";
import { cn } from "@/lib/utils";
import { MetaTile } from "./MetaTile";
import { MutedLabel } from "./MutedLabel";
import type {
  ProvenanceField,
  ProvenanceGroup,
} from "../utils/rebuild-provenance.util";

const FieldValue = ({ field }: { field: ProvenanceField }) => {
  const className = cn("break-all", field.mono && "font-mono text-[0.8rem]");
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

/** How this contract was rebuilt, grouped by who chose each value — see `rebuildProvenance`. */
export const RebuildCard = ({ groups }: RebuildCardProps) => {
  if (!groups.length) return null;

  return (
    <section
      data-testid="rebuild-provenance"
      className="rounded-xl border border-line bg-surface p-6 shadow-panel"
    >
      <h2 className="m-0 mb-1 text-[1.35rem] font-semibold">
        How this was rebuilt
      </h2>
      <p className="m-0 mb-4 text-[0.85rem] leading-[1.5] text-ink/[0.66]">
        Grouped by who chose each value.
      </p>

      <div className="space-y-5">
        {groups.map((group) => (
          <div key={group.key} data-testid={`provenance-${group.key}`}>
            <MutedLabel>{group.title}</MutedLabel>
            <p className="m-0 mb-2.5 mt-0.5 text-[0.78rem] leading-[1.45] text-ink/[0.6]">
              {group.origin}
            </p>
            <div className="grid gap-3 text-[0.875rem] md:grid-cols-2">
              {group.fields.map((field) => (
                <MetaTile
                  key={field.key}
                  label={field.label}
                  value={<FieldValue field={field} />}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
};
