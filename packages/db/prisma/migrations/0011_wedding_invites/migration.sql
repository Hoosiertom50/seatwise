-- FR-1.4/FR-1.4a (TS-4, closing the last of the three documented gaps): a Couple-vs-Collaborator
-- role separate from permission level, plus a real invite lifecycle (token, pending/accepted/
-- revoked, no guest data, accept gated on the invited address).

CREATE TYPE "CollaboratorRole" AS ENUM ('COUPLE', 'COLLABORATOR');

-- Existing collaborators (added under the old instant add-by-email flow, before roles existed)
-- default to COLLABORATOR -- the safer of the two, since COUPLE carries FR-6.4 approval authority
-- that nobody granted them explicitly.
ALTER TABLE "wedding_collaborators" ADD COLUMN "role" "CollaboratorRole" NOT NULL DEFAULT 'COLLABORATOR';

CREATE TYPE "WeddingInviteStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REVOKED');

CREATE TABLE "wedding_invites" (
    "id" TEXT NOT NULL,
    "weddingId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" "CollaboratorRole" NOT NULL,
    "permissionLevel" "CollaboratorPermission" NOT NULL,
    "token" TEXT NOT NULL,
    "status" "WeddingInviteStatus" NOT NULL DEFAULT 'PENDING',
    "invitedByUserId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wedding_invites_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "wedding_invites_token_key" ON "wedding_invites"("token");
CREATE INDEX "wedding_invites_weddingId_idx" ON "wedding_invites"("weddingId");
CREATE INDEX "wedding_invites_email_idx" ON "wedding_invites"("email");

ALTER TABLE "wedding_invites" ADD CONSTRAINT "wedding_invites_weddingId_fkey"
    FOREIGN KEY ("weddingId") REFERENCES "weddings"("id") ON DELETE CASCADE ON UPDATE CASCADE;
