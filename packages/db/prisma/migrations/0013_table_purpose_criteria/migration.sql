-- FR-3.7: a Purpose table's structured criteria (Side / Relationship Tier / Age Category), on top
-- of its existing free-text `purpose` label, treated as a soft preference by generation.

-- Lets an Age Category criterion (e.g. "Kids' Table") mean something -- no prior field
-- categorized a guest by age.
CREATE TYPE "AgeCategory" AS ENUM ('ADULT', 'CHILD', 'INFANT');
ALTER TABLE "guests" ADD COLUMN "ageCategory" "AgeCategory" NOT NULL DEFAULT 'ADULT';

CREATE TYPE "TablePurposeCriterionType" AS ENUM ('SIDE', 'TIER', 'AGE_CATEGORY');
ALTER TABLE "seating_tables" ADD COLUMN "purposeCriterionType" "TablePurposeCriterionType";
ALTER TABLE "seating_tables" ADD COLUMN "purposeCriterionValue" TEXT;
