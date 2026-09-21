import { HashCompare } from "@/components/hash-compare";
import { hashChunks } from "../utils/format.util";
import { MonoLabel } from "./MonoLabel";

/**
 * The deployed digest held against the rebuilt one, chunk by chunk — the landing page's device, on this job's
 * real hashes. Renders nothing unless both are digests: a comparison of malformed strings would mark chunks as
 * differing for a reason that is not the rebuild.
 */
export const DigestCompare = ({
  deployed,
  rebuilt,
}: {
  deployed: unknown;
  rebuilt: unknown;
}) => {
  const deployedChunks = hashChunks(deployed);
  const rebuiltChunks = hashChunks(rebuilt);
  if (!deployedChunks || !rebuiltChunks) return null;

  return (
    <div data-testid="digest-compare">
      <MonoLabel>deployed</MonoLabel>
      <HashCompare
        compare={{ deployed: deployedChunks, rebuilt: rebuiltChunks }}
        className="my-1.5"
      />
      <MonoLabel>rebuilt</MonoLabel>
    </div>
  );
};
