-- TS-234: at most one pending invite per email address per wedding. Sending an invite already
-- replaces any pending one for that address, but two sent at the same moment could both stay
-- pending. The app now sends invites under the wedding's lock; this index makes the database
-- enforce it too.
--
-- First, any duplicates already saved are tidied up the same way a re-invite would: the newest
-- pending invite for each wedding and address is kept, the older ones are revoked. Without this,
-- creating the index would fail on a database that already has a duplicate.
UPDATE "wedding_invites" wi
SET status = 'REVOKED'
WHERE wi.status = 'PENDING'
  AND EXISTS (
    SELECT 1 FROM "wedding_invites" newer
    WHERE newer."weddingId" = wi."weddingId"
      AND lower(newer.email) = lower(wi.email)
      AND newer.status = 'PENDING'
      AND (newer."createdAt" > wi."createdAt" OR (newer."createdAt" = wi."createdAt" AND newer.id > wi.id))
  );

-- Prisma can't describe a partial index on an expression in schema.prisma (see the comment on
-- WeddingInvite there), so it lives only here.
CREATE UNIQUE INDEX "wedding_invites_one_pending_per_email"
  ON "wedding_invites" ("weddingId", lower(email))
  WHERE status = 'PENDING';
