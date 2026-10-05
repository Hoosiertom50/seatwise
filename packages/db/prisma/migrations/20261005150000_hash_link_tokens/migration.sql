-- TS-160: RSVP, vendor share and invite links are looked up by a SHA-256 hash of their token, so
-- the database never holds a usable link in the clear.
--
-- Invites: the "token" column now holds the hash (the raw token is only ever in the emailed link).
-- Existing pending invites keep working: their tokens are hashed in place.
UPDATE "wedding_invites" SET token = encode(sha256(convert_to(token, 'UTF8')), 'hex');

-- Guests and vendors: a new hash column is what links are looked up by. "rsvpToken" / "shareToken"
-- keep an encrypted copy so the planner's "RSVP link" / "Share link" buttons can still show the
-- current link; the app encrypts any older plain copy the next time it reads it.
ALTER TABLE "guests" ADD COLUMN "rsvpTokenHash" TEXT;
UPDATE "guests" SET "rsvpTokenHash" = encode(sha256(convert_to("rsvpToken", 'UTF8')), 'hex')
WHERE "rsvpToken" IS NOT NULL;
CREATE UNIQUE INDEX "guests_rsvpTokenHash_key" ON "guests"("rsvpTokenHash");

ALTER TABLE "vendors" ADD COLUMN "shareTokenHash" TEXT;
UPDATE "vendors" SET "shareTokenHash" = encode(sha256(convert_to("shareToken", 'UTF8')), 'hex')
WHERE "shareToken" IS NOT NULL;
CREATE UNIQUE INDEX "vendors_shareTokenHash_key" ON "vendors"("shareTokenHash");
