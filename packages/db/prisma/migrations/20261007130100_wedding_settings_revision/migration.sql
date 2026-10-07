-- TS-214: a counter bumped on every change to a wedding's own settings (name, date, venue, note,
-- side names, side mixing, RSVP cutoff). A save based on an older copy is refused (409) with the
-- latest values, instead of silently putting back what another tab or person just changed.
-- Separate from "budgetRevision" (TS-92), which covers the budget alone. Every existing wedding
-- starts at 0. Adding a column with a constant default doesn't rewrite the table.
ALTER TABLE "weddings" ADD COLUMN "settingsRevision" INTEGER NOT NULL DEFAULT 0;
