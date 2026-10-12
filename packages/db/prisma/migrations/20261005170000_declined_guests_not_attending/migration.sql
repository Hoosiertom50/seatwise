-- TS-169: guests who declined before TS-167 ("declining gives up the seat") are brought in line:
-- they're marked Not Attending and lose their seat in each wedding's current plan, and those plans'
-- completeness is recounted. Past (non-current) versions are left as they were. Guests whose
-- attendance a planner had already set to Not Attending are unaffected.
-- TS-173: a plan that loses seats also gets its revision bumped (so anyone holding the old copy
-- gets a conflict instead of acting on it) and a line in its history, like any other freed seat --
-- which is also what shows "Modified since approval" on an approved plan.

-- The current plans that lose seats, and how many.
CREATE TEMP TABLE "ts169_freed" AS
SELECT sa."planVersionId", COUNT(*)::int AS "seats"
FROM "seat_assignments" sa
JOIN "plan_versions" pv ON pv.id = sa."planVersionId" AND pv."isCurrent"
JOIN "guests" g ON g.id = sa."guestId" AND g."rsvpStatus" = 'DECLINED' AND g."dayOfAttendance" = 'ATTENDING'
GROUP BY sa."planVersionId";

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

-- TS-173: revision and history for the plans that lost seats.
UPDATE "plan_versions" pv SET revision = revision + 1
FROM "ts169_freed" f WHERE pv.id = f."planVersionId";

INSERT INTO "change_history_entries" (id, "planVersionId", action, description)
SELECT gen_random_uuid()::text, f."planVersionId", 'ATTENDANCE_CHANGE',
       f."seats" || ' guest(s) who had declined were marked not attending — seats freed'
FROM "ts169_freed" f;

DROP TABLE "ts169_freed";
