-- TS-18 (Day-Of Timeline / Run-of-Show): a per-wedding chronological schedule of day-of events
-- (FR-13.1), stored as its own record entirely independent of guests/tables/rules/seating plans
-- (FR-13.2) -- deleting a wedding cascades its timeline away, but nothing else does. "time" is a
-- plain zero-padded 24-hour "HH:MM" string (validated at the Zod layer) rather than a TIME/
-- TIMESTAMP column: a run-of-show is a flat list of clock-face labels ("4:30 PM"), not real
-- datetimes, and a plain zero-padded string sorts correctly with ordinary text ordering. "sortOrder"
-- is a tie-breaker for entries that share the same displayed time (e.g. "5:00 PM - Guests seated" /
-- "5:00 PM - Ceremony begins") and is also what a planner's explicit reorder action (FR-13.2) moves
-- -- entries are always listed by (time, sortOrder), so reordering same-time entries is the only
-- reordering that can actually change display order, exactly matching FR-13.1's "always
-- chronological" requirement.
CREATE TABLE "timeline_entries" (
    "id" TEXT NOT NULL,
    "weddingId" TEXT NOT NULL,
    "time" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "timeline_entries_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "timeline_entries_weddingId_idx" ON "timeline_entries"("weddingId");

ALTER TABLE "timeline_entries" ADD CONSTRAINT "timeline_entries_weddingId_fkey"
  FOREIGN KEY ("weddingId") REFERENCES "weddings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- FR-13.3: "comment on individual entries, reusing the existing comment system's pattern" -- a
-- third CommentTargetType alongside GUEST/TABLE, with the same "nullable target column + captured
-- targetLabel" shape so a comment on a since-removed timeline entry still stands (see comments.ts).
ALTER TYPE "CommentTargetType" ADD VALUE 'TIMELINE_ENTRY';

ALTER TABLE "comments" ADD COLUMN "timelineEntryId" TEXT;

CREATE INDEX "comments_timelineEntryId_idx" ON "comments"("timelineEntryId");

ALTER TABLE "comments" ADD CONSTRAINT "comments_timelineEntryId_fkey"
  FOREIGN KEY ("timelineEntryId") REFERENCES "timeline_entries"("id") ON DELETE SET NULL ON UPDATE CASCADE;
