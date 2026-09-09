-- FR-1.3a (TS-4, closing a documented gap): each wedding names its own two sides (default
-- "Bride"/"Groom") as a purely display-level label. The underlying GuestSide value stored on a
-- guest (BRIDE/GROOM/BOTH) is unaffected -- renaming these never touches a guest, rule, or seat
-- assignment record.

ALTER TABLE "weddings" ADD COLUMN "sideLabel1" TEXT NOT NULL DEFAULT 'Bride';
ALTER TABLE "weddings" ADD COLUMN "sideLabel2" TEXT NOT NULL DEFAULT 'Groom';
