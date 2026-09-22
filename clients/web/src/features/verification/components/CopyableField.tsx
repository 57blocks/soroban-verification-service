import { Copy } from "lucide-react";
import { MonoChip } from "@/components/mono-chip";
import { copyValue } from "../utils/clipboard.util";
import { MonoLabel } from "./MonoLabel";

type CopyableFieldProps = {
  label: string;
  value?: string;
  copyable?: boolean;
};

/** A label over its value, with the inline copy button the design puts beside every hash and id. */
export const CopyableField = ({
  label,
  value,
  copyable = true,
}: CopyableFieldProps) => (
  <div className="min-w-0">
    <MonoLabel>{label}</MonoLabel>
    <div className="mt-1.5 flex min-w-0 items-start gap-2">
      <MonoChip className="min-w-0 flex-1 text-[12px] text-ink">
        {value || "none"}
      </MonoChip>
      {copyable && value && value !== "none" && (
        <button
          type="button"
          onClick={() => copyValue(value)}
          title="Copy to clipboard"
          aria-label={`Copy ${label}`}
          className="mt-0.5 grid size-[26px] shrink-0 place-items-center rounded-md border-0 bg-transparent p-0 text-ink-mute transition-colors hover:bg-yellow-soft hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yellow"
        >
          <Copy size={13} />
        </button>
      )}
    </div>
  </div>
);
