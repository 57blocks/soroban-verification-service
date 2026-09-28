import type { RejectedBuildOption } from "../types";
import { MonoLabel } from "./MonoLabel";

type RejectedOptionsProps = {
  rejected: RejectedBuildOption[];
};

export const RejectedOptions = ({ rejected }: RejectedOptionsProps) => {
  if (rejected.length === 0) return null;

  return (
    <div data-testid="rejected-options" className="mt-4 rounded-lg bg-danger-surface p-4">
      <MonoLabel className="text-danger-fg">policy_rejected</MonoLabel>
      <p className="mb-0 mt-1 text-[0.9rem] text-ink-body">
        These build options cannot be replayed as written. This is not a feature that is coming
        later — correct or remove them to submit.
      </p>
      <ul className="mb-0 mt-3 space-y-2 pl-0">
        {rejected.map((entry) => (
          <li key={entry.option} className="list-none">
            <code className="break-all font-mono text-[0.85rem] text-ink-value">{entry.option}</code>
            <span className="block text-[0.85rem] text-ink-body">{entry.detail}</span>
          </li>
        ))}
      </ul>
    </div>
  );
};
