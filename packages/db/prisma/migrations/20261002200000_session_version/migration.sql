-- TS-155: every session token carries the account's session version; bumping it (password reset,
-- log out) ends every session issued before. Existing sessions carry no version and count as 0,
-- so nobody is signed out by this migration itself.
ALTER TABLE "users" ADD COLUMN "sessionVersion" INTEGER NOT NULL DEFAULT 0;
