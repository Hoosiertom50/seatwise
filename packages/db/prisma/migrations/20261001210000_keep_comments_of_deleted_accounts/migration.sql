-- TS-105: deleting an account keeps the comments it wrote on other people's weddings.
ALTER TABLE "comments" ALTER COLUMN "authorUserId" DROP NOT NULL;
ALTER TABLE "comments" DROP CONSTRAINT "comments_authorUserId_fkey";
ALTER TABLE "comments" ADD CONSTRAINT "comments_authorUserId_fkey"
  FOREIGN KEY ("authorUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
