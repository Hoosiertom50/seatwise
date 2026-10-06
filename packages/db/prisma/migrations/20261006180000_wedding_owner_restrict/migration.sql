-- TS-187: an account can no longer be deleted while it owns a wedding -- the database itself now
-- refuses it (ON DELETE RESTRICT), where before it deleted the wedding along with the account
-- (ON DELETE CASCADE). The app already refuses to delete an account that owns a wedding, but an
-- account deleted at the very moment a wedding was handed to it took that wedding with it.
-- Only this one link changes; every other link to "users" is left as it was.
ALTER TABLE "weddings" DROP CONSTRAINT "weddings_ownerId_fkey";
ALTER TABLE "weddings" ADD CONSTRAINT "weddings_ownerId_fkey"
  FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
