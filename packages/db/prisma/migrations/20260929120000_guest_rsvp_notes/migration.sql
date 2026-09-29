-- TS-107: give the guest's own RSVP-form note its own column, separate from the planner's private
-- `notes`. Before this, the public RSVP page read and overwrote `notes` directly, so a guest could
-- see (and erase) whatever the planner had written about them.
--
-- Deliberately no backfill from `notes`: a row's existing `notes` can't be attributed to the guest
-- or the planner after the fact (either could have written last), and copying it here would put a
-- planner's note back in front of the guest -- the exact leak this column exists to close.
-- Encrypted at rest the same way `notes` is (NFR-9.3b) -- see packages/db/src/crypto.ts.

ALTER TABLE "guests" ADD COLUMN "rsvpNotes" TEXT;
