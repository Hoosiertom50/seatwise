-- TS-6 (Relationships & Seating Rules) closing two gaps left deferred in earlier stories:
-- FR-3.4 (Side-Mixing) and FR-3.7a (Restricted table required guest list).

CREATE TYPE "SideMixingSetting" AS ENUM ('KEEP_SEPARATE', 'BALANCED_MIX', 'FULLY_MIXED');
CREATE TYPE "GuestSide" AS ENUM ('BRIDE', 'GROOM', 'BOTH');

ALTER TABLE "weddings" ADD COLUMN "sideMixing" "SideMixingSetting" NOT NULL DEFAULT 'BALANCED_MIX';
ALTER TABLE "guests" ADD COLUMN "side" "GuestSide" NOT NULL DEFAULT 'BOTH';
ALTER TABLE "seating_tables" ADD COLUMN "singleSideOnly" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "plan_versions" ADD COLUMN "sideMixingSetting" "SideMixingSetting";
ALTER TABLE "plan_versions" ADD COLUMN "ruleConfigVersion" INTEGER;

CREATE TABLE "restricted_table_guests" (
    "id" TEXT NOT NULL,
    "tableId" TEXT NOT NULL,
    "guestId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "restricted_table_guests_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "restricted_table_guests_tableId_guestId_key" ON "restricted_table_guests"("tableId", "guestId");
-- A guest may be required at only one Restricted table wedding-wide (FR-3.7a) -- enforced here,
-- not just in application code.
CREATE UNIQUE INDEX "restricted_table_guests_guestId_key" ON "restricted_table_guests"("guestId");

ALTER TABLE "restricted_table_guests" ADD CONSTRAINT "restricted_table_guests_tableId_fkey" FOREIGN KEY ("tableId") REFERENCES "seating_tables"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "restricted_table_guests" ADD CONSTRAINT "restricted_table_guests_guestId_fkey" FOREIGN KEY ("guestId") REFERENCES "guests"("id") ON DELETE CASCADE ON UPDATE CASCADE;
