import { Copy } from "lucide-react";
import { copyValue } from "../utils/clipboard.util";
import { MutedLabel } from "./MutedLabel";

type CopyableFieldProps = {
  label: string;
  value?: string;
  mono?: boolean;
  copyable?: boolean;
};

/** A label over its value, with the inline copy button the design puts beside every hash and id. */
export const CopyableField = ({
  label,
  value,
  mono = false,
  copyable = true,
}: CopyableFieldProps) => (
  <div className="min-w-0">
    <MutedLabel>{label}</MutedLabel>
    <div className="mt-1 flex min-w-0 items-center gap-2">
      <span
        className={[
          "min-w-0 text-[0.9rem] text-ink",
          mono
            ? "scroll-x-hidden overflow-x-auto whitespace-nowrap font-mono"
            : "font-medium",
        ].join(" ")}
      >
        {value || "none"}
      </span>
      {copyable && value && value !== "none" && (
        <button
          type="button"
          onClick={() => copyValue(value)}
          title="Copy to clipboard"
          aria-label={`Copy ${label}`}
          className="grid size-[26px] shrink-0 place-items-center rounded-md border-0 bg-transparent p-0 text-ink-warm transition-colors hover:bg-yellow-soft hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yellow"
        >
          <Copy size={13} />
        </button>
      )}
    </div>
  </div>
);
