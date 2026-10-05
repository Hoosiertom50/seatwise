-- TS-169: guests who declined before TS-167 ("declining gives up the seat") are brought in line:
-- they're marked Not Attending and lose their seat in each wedding's current plan, and those plans'
-- completeness is recounted. Past (non-current) versions are left as they were. Guests whose
-- attendance a planner had already set to Not Attending are unaffected.

-- Their seats in the current plan.
DELETE FROM "seat_assignments" sa
USING "plan_versions" pv, "guests" g
WHERE sa."planVersionId" = pv.id AND pv."isCurrent"
  AND g.id = sa."guestId" AND g."rsvpStatus" = 'DECLINED' AND g."dayOfAttendance" = 'ATTENDING';

-- Their attendance (revision bumped, like any other change to a guest).
UPDATE "guests"
SET "dayOfAttendance" = 'NOT_ATTENDING', revision = revision + 1, "updatedAt" = now()
WHERE "rsvpStatus" = 'DECLINED' AND "dayOfAttendance" = 'ATTENDING';

-- Completeness of every current plan, recounted the same way the app does it.
UPDATE "plan_versions" pv
SET "isComplete" = (
  NOT EXISTS (
    SELECT 1 FROM "guests" g
    WHERE g."weddingId" = pv."weddingId" AND g."dayOfAttendance" = 'ATTENDING'
      AND NOT EXISTS (SELECT 1 FROM "seat_assignments" sa WHERE sa."planVersionId" = pv.id AND sa."guestId" = g.id)
  )
  AND NOT EXISTS (SELECT 1 FROM "seat_assignments" sa WHERE sa."planVersionId" = pv.id AND sa."needsReassignment")
)
WHERE pv."isCurrent";
