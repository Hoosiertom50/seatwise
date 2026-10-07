-- TS-213: each member of a wedding can turn notification emails off for themselves ("Email me
-- about this wedding" on the Collaborators tab) -- a collaborator on their own access row, the
-- owner on the wedding. Everyone starts with emails on, as now. Adding a column with a constant
-- default doesn't rewrite the table or hold a long lock.
ALTER TABLE "wedding_collaborators" ADD COLUMN "emailNotificationsEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "weddings" ADD COLUMN "ownerEmailNotificationsEnabled" BOOLEAN NOT NULL DEFAULT true;

-- TS-203: when an invite's email went out. Accepting an invite whose email went out confirms the
-- account's address; one whose email failed (the owner copied the link) doesn't. Invites already
-- sent have no record of it, so they're treated as not emailed (accepting one confirms nothing).
ALTER TABLE "wedding_invites" ADD COLUMN "emailedAt" TIMESTAMP(3);
