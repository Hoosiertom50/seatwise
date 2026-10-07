-- TS-214: a timeline entry can be marked "after midnight (next day)", so a 12:30 AM last dance is
-- listed after the 4:00 PM ceremony instead of before it. Every existing entry stays on the
-- wedding day (false), exactly as it is listed today; the planner ticks the box where it's needed.
-- Adding a column with a constant default doesn't rewrite the table.
ALTER TABLE "timeline_entries" ADD COLUMN "nextDay" BOOLEAN NOT NULL DEFAULT false;
