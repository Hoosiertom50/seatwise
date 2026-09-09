-- Adds the missing "is this table wheelchair/accessible-capable" flag needed to enforce the
-- Requires Accessible Table hard rule (FR) when generating a seating plan.
ALTER TABLE "seating_tables" ADD COLUMN "isAccessible" BOOLEAN NOT NULL DEFAULT FALSE;
