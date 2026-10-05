-- TS-154 (Tom's decision #2): the party size the planner allowed, kept separately from the
-- headcount the guest answers with -- so an RSVP can never raise it, and a guest who answers "1"
-- can still change back to the full party later. NULL means "the headcount is the limit" (no RSVP
-- since the planner last set it).
ALTER TABLE "guests" ADD COLUMN "partySizeLimit" INTEGER;

-- ...and planners are told when a guest responds.
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'RSVP_RECEIVED';
