import { formatValue } from "../utils/format.util";

/** What the verifier could already resolve from chain metadata. */
export const EvidenceMetadata = ({
  availableFields,
}: {
  availableFields: Record<string, unknown>;
}) => (
  <div className="mb-6">
    <h3 className="m-0 mb-3 text-[0.875rem] font-semibold uppercase text-ink-label">
      Available metadata
    </h3>

    {Object.keys(availableFields).length ? (
      <div className="grid gap-2 text-[0.875rem]">
        {Object.entries(availableFields).map(([key, value]) => (
          <div
            key={key}
            className="grid gap-1 rounded-md bg-surface-field px-3 py-2 md:grid-cols-[132px_1fr]"
          >
            <span className="text-[0.7rem] font-semibold uppercase text-ink-warm">
              {key}
            </span>
            <span
              className="break-all font-medium text-ink"
              title={formatValue(value)}
            >
              {formatValue(value)}
            </span>
          </div>
        ))}
      </div>
    ) : (
      <p className="m-0 text-[0.875rem] leading-[1.5] text-ink/[0.66]">
        No reusable metadata was found for this target.
      </p>
    )}
  </div>
);
