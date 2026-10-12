-- TS-204 (Tom's decision): "Log out" ends only the session on this device. Each session token now
-- carries its own id; logging out records that id here until the token would have expired anyway,
-- and a token whose id is here is refused. "Log out on all devices" and a password reset still end
-- every session at once (users."sessionVersion", TS-155).
-- New, empty table only -- nothing existing is changed or locked for long.
CREATE TABLE "revoked_sessions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "revoked_sessions_pkey" PRIMARY KEY ("id")
);

-- Clearing out rows whose token has expired anyway.
CREATE INDEX "revoked_sessions_expiresAt_idx" ON "revoked_sessions"("expiresAt");
CREATE INDEX "revoked_sessions_userId_idx" ON "revoked_sessions"("userId");

ALTER TABLE "revoked_sessions" ADD CONSTRAINT "revoked_sessions_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
