import { MonoChip } from "@/components/mono-chip";
import { formatValue } from "../utils/format.util";
import { MonoLabel } from "./MonoLabel";

export const EvidenceMetadata = ({
  availableFields,
}: {
  availableFields: Record<string, unknown>;
}) => (
  <div className="mb-6">
    <MonoLabel as="h3" className="mb-2.5">
      Available metadata
    </MonoLabel>

    {Object.keys(availableFields).length ? (
      <div className="grid gap-2">
        {Object.entries(availableFields).map(([key, value]) => (
          <MonoChip
            key={key}
            className="text-[12px]"
            sample={[
              { text: `${key}  `, tone: "key" },
              { text: formatValue(value), tone: "value" },
            ]}
          />
        ))}
      </div>
    ) : (
      <p className="m-0 text-[0.875rem] leading-[1.5] text-ink/[0.66]">
        No reusable metadata was found for this target.
      </p>
    )}
  </div>
);
