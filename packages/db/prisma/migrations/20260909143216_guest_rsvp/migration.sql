-- TS-17 (Client-Facing RSVP Collection): a guest can submit their own RSVP via a unique,
-- unauthenticated, token-based link (FR-12.1), writing directly into their own guest record
-- (FR-12.3) rather than a separate copy. "email" lets a planner actually deliver that link (by
-- resending it); "plusOneNames" covers "a plus-one's info" (FR-12.1) on top of the headcount field
-- that already exists. "rsvpToken" is generated lazily (on first "get/send link" action, not at
-- guest creation) -- most guests, especially bulk-imported ones, may never need one, so nothing
-- pre-populates it. "rsvpRespondedAt" is deliberately separate from rsvpStatus/updatedAt: it's set
-- only by the guest's own public submission (see submitGuestRsvp), never by a planner editing the
-- guest directly, so FR-12.4's "responded via their link" status means exactly that and nothing
-- else. "rsvpCutoffDate" on the wedding is FR-12.2's planner-configured cutoff -- null means no
-- cutoff at all, matching the FR's "or none" language.

ALTER TABLE "guests" ADD COLUMN "email" TEXT;
ALTER TABLE "guests" ADD COLUMN "plusOneNames" TEXT;
ALTER TABLE "guests" ADD COLUMN "rsvpToken" TEXT;
ALTER TABLE "guests" ADD COLUMN "rsvpRespondedAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "guests_rsvpToken_key" ON "guests"("rsvpToken");

ALTER TABLE "weddings" ADD COLUMN "rsvpCutoffDate" DATE;
