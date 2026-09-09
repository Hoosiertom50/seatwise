-- TS-11 (Day-Of / Emergency Mode, FR-8.1): attendance is distinct from rsvpStatus — a guest can
-- RSVP Confirmed weeks ahead and still no-show day-of, or walk in unannounced. This tracks the
-- same-day, freely-flippable signal that drives seat-freeing/re-seating without a full
-- regeneration.
CREATE TYPE "DayOfAttendance" AS ENUM ('ATTENDING', 'NOT_ATTENDING');
ALTER TABLE "guests" ADD COLUMN "dayOfAttendance" "DayOfAttendance" NOT NULL DEFAULT 'ATTENDING';
