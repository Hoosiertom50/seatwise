-- TS-232: when a guest's email address last changed. "Listed for over a day" (the planner's kept
-- email to a guest) went by "updatedAt", so any edit -- or the guest's own RSVP -- made the guest
-- look newly listed. Additive and nullable: adding a column with a constant-per-statement default
-- doesn't rewrite the table. Existing guests start from their last edit ("updatedAt") -- never
-- earlier than the truth, so nobody is treated as listed longer than they were.
ALTER TABLE "guests" ADD COLUMN "emailChangedAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP;
UPDATE "guests" SET "emailChangedAt" = "updatedAt";
