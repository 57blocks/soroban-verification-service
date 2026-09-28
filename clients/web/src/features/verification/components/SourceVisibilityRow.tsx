import type { ReactNode } from "react";
import type { PublishedArtifactState } from "../types";
import { MonoLabel } from "./MonoLabel";

const Sentence = ({ children }: { children: ReactNode }) => (
  <p className="m-0 text-[0.85rem] leading-[1.5] text-ink-value">{children}</p>
);

type SourceVisibilityRowProps = {
  state: PublishedArtifactState;
};

export const SourceVisibilityRow = ({ state }: SourceVisibilityRowProps) => {
  if (state.phase === "not_published") return null;

  if (state.phase === "loading") {
    return <Sentence>Checking source availability...</Sentence>;
  }

  if (state.phase === "unreadable" || state.source.isPublic === null) {
    return (
      <div data-testid="source-visibility">
        <MonoLabel>Source availability</MonoLabel>
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
      <MonoLabel>Source</MonoLabel>
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
      {isPublic && fileName && <Sentence>Published as {fileName}</Sentence>}
    </div>
  );
};
