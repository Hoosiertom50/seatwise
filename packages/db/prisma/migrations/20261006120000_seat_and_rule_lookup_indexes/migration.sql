-- TS-183: indexes for looking seats and seating rules up by guest or table. Every guest delete,
-- table delete and re-check finds a guest's seats (or a table's) and a guest's rules; without
-- these, each of those reads every row of the table. Names match what Prisma generates for the
-- @@index lines in schema.prisma, so `prisma migrate diff` sees no difference. IF NOT EXISTS keeps
-- it safe on a database where one was already added by hand.
CREATE INDEX IF NOT EXISTS "seat_assignments_guestId_idx" ON "seat_assignments"("guestId");
CREATE INDEX IF NOT EXISTS "seat_assignments_seatingTableId_idx" ON "seat_assignments"("seatingTableId");
CREATE INDEX IF NOT EXISTS "guest_relationships_guestAId_idx" ON "guest_relationships"("guestAId");
CREATE INDEX IF NOT EXISTS "guest_relationships_guestBId_idx" ON "guest_relationships"("guestBId");
