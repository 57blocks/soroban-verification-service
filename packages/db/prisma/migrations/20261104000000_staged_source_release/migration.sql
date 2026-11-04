-- When every staging copy of this rebuild's source (the URL fetch and the unwrapped archive, one per
-- build mode) was deleted. NULL while any may still exist; the sweep that retries a deletion the terminal
-- path missed reads this column, and a re-dispatch clears it because the next attempt writes new copies.
ALTER TABLE "rebuilds" ADD COLUMN "staged_source_released_at" TIMESTAMP(3);

-- The sweep's query: finished rebuilds whose staging copies have not yet been released, oldest first.
CREATE INDEX "rebuilds_staged_source_unreleased_idx"
  ON "rebuilds" ("updated_at")
  WHERE "status" = 'done' AND "staged_source_released_at" IS NULL;
