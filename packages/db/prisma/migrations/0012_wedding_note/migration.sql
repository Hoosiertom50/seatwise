-- FR-1.3: "a wedding has couple's names, date, venue, and an optional note" -- the last of the
-- four fields never built. Always optional.
ALTER TABLE "weddings" ADD COLUMN "note" TEXT;
