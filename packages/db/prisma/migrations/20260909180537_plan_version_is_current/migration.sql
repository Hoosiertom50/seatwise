-- TS-8 (FR-5.6): give a Plan Version a real, independent "is this the Current version" flag,
-- decoupled from versionNumber ordering. Before this, "Current" was always computed as
-- "versionNumber = MAX(versionNumber) for this wedding" -- which meant a "Save as Comparison
-- Draft" generation had no way to exist without immediately becoming Current just by being the
-- newest version. This column lets the two diverge.

ALTER TABLE "plan_versions" ADD COLUMN "isCurrent" BOOLEAN NOT NULL DEFAULT false;

-- Backfill: whichever version already had the highest versionNumber for each wedding was the de
-- facto Current version before this column existed -- preserve that as the explicit Current so
-- existing data keeps behaving exactly as it did.
UPDATE "plan_versions" pv
SET "isCurrent" = true
WHERE pv."versionNumber" = (
  SELECT MAX("versionNumber") FROM "plan_versions" WHERE "weddingId" = pv."weddingId"
);

-- Enforce the invariant at the database level: at most one Current version per wedding. A plain
-- (non-partial) unique index can't express "at most one true", so this is a partial index over
-- just the true rows.
CREATE UNIQUE INDEX "plan_versions_one_current_per_wedding"
  ON "plan_versions" ("weddingId")
  WHERE "isCurrent";
