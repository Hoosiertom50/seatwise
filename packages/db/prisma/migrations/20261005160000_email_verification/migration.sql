-- TS-164: confirming an email address. A new account isn't confirmed until its owner clicks the
-- link emailed to them; until then it can't email other people (invites, RSVP links) or accept an
-- invite. Accounts that already exist are treated as confirmed, so nobody using Seatwise today is
-- locked out of anything.
ALTER TABLE "users" ADD COLUMN "emailVerifiedAt" TIMESTAMP(3);
UPDATE "users" SET "emailVerifiedAt" = "createdAt";

-- Same design as password_reset_tokens (TS-142): only a SHA-256 hash of the emailed token is kept.
CREATE TABLE "email_verification_tokens" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_verification_tokens_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "email_verification_tokens_tokenHash_key" ON "email_verification_tokens"("tokenHash");
CREATE INDEX "email_verification_tokens_userId_idx" ON "email_verification_tokens"("userId");

ALTER TABLE "email_verification_tokens" ADD CONSTRAINT "email_verification_tokens_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
