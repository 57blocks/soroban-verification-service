-- At least one link this job owes wasms/<hash>.json is missing from the document. One flag for all three
-- link kinds; the recovery scan derives which are owed from archived_tx_id / source_archived_tx_id /
-- source_file_name and replays them idempotently.
ALTER TABLE "jobs" ADD COLUMN "status_link_pending_since" TIMESTAMP(3);

-- Automatic recovery has stopped and a human has to look. Blocked refines pending rather than replacing it.
ALTER TABLE "jobs" ADD COLUMN "status_link_blocked_since" TIMESTAMP(3);
ALTER TABLE "jobs" ADD COLUMN "status_link_blocked_reason" TEXT;

-- The three columns carry one state between them, and two of their eight combinations are not states:
-- a blocked time without a reason (or the reverse), and a blocked job that does not also owe the link.
-- Enforced here rather than left to the one repository method that writes them, because a row that reaches
-- an impossible state is not something a later reader can recover from.
--
-- The reason's VALUES are deliberately not constrained: the set is closed in TypeScript
-- (`StatusLinkBlockedReason`), and adding one should not need a migration.
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_status_link_blocked_shape" CHECK (
  ("status_link_blocked_since" IS NULL) = ("status_link_blocked_reason" IS NULL)
  AND ("status_link_blocked_since" IS NULL OR "status_link_pending_since" IS NOT NULL)
);

-- The recovery scan's query: owed, and not held for a human. No time bound — unlike the source-publish
-- scan, whose input can be permanently gone, every input this replay needs is durable.
CREATE INDEX "jobs_status_link_pending_since_idx"
  ON "jobs" ("status_link_pending_since")
  WHERE "status_link_pending_since" IS NOT NULL AND "status_link_blocked_reason" IS NULL;
