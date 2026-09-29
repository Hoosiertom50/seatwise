-- TS-92: optimistic-concurrency counters for the last two shared, editable things that had none,
-- so a stale save is refused with a message instead of silently overwriting a collaborator's edit
-- (FR-7.7's pattern, already on guests, tables, vendors and plan versions).
--
-- budgetRevision is deliberately separate from anything else on the weddings row: the budget
-- total is edited from the Budget tab by any Edit collaborator, while the wedding's own details
-- are owner-only -- sharing one counter would make unrelated edits conflict with each other.

ALTER TABLE "timeline_entries" ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "weddings" ADD COLUMN "budgetRevision" INTEGER NOT NULL DEFAULT 0;
