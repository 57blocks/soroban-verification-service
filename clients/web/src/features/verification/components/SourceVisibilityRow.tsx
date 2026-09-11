import type { ReactNode } from "react";
import type { PublishedArtifactState } from "../types";
import { MutedLabel } from "./MutedLabel";

/**
 * `MutedLabel` is `uppercase`, which is right for a caption and wrong for a sentence — and actively harmful
 * over 64 hex characters.
 */
const Sentence = ({ children }: { children: ReactNode }) => (
  <p className="m-0 text-[0.85rem] leading-[1.5] text-ink-value">{children}</p>
);

type SourceVisibilityRowProps = {
  state: PublishedArtifactState;
};

/** Whether this result's source can be retrieved, shown beside the verdict and never inside it. */
export const SourceVisibilityRow = ({ state }: SourceVisibilityRowProps) => {
  if (state.phase === "not_published") return null;

  if (state.phase === "loading") {
    return <Sentence>Checking source availability...</Sentence>;
  }

  if (state.phase === "unreadable" || state.source.isPublic === null) {
    return (
      <div data-testid="source-visibility">
        <MutedLabel>Source availability</MutedLabel>
        <Sentence>
          Not stated by this result. That is not the same as non-public — it could not be
          determined.
        </Sentence>
      </div>
    );
  }

  const { isPublic, sourceSha256, fileName } = state.source;

  return (
    <div data-testid="source-visibility" className="space-y-1">
      <MutedLabel>Source</MutedLabel>
      <Sentence>
        {isPublic
          ? "Published, and retrievable by anyone."
          : "Not public. The bytes were used for the rebuild and deleted; the SHA-256 commitment below is what was verified."}
      </Sentence>
      {sourceSha256 && (
        <p className="m-0 scroll-x-hidden overflow-x-auto whitespace-nowrap font-mono text-[0.75rem] text-ink-value">
          source_sha256 {sourceSha256}
        </p>
      )}
      {/* The filename repeats the digest, deliberately: naming the exact object a reader can fetch
          is a prior decision, pinned by `source-visibility.spec.tsx`. */}
      {isPublic && fileName && <Sentence>Published as {fileName}</Sentence>}
    </div>
  );
};
