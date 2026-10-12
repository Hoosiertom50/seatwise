-- TS-209: the answer to each committed guest import, kept under the key the browser sent with it.
-- When the answer to an import is lost (a dropped connection, a time-out) and the planner presses
-- Import again, the same key comes back and the first import's answer is given again -- the file
-- isn't imported a second time (every new guest used to be added twice). A new table only; rows are
-- removed with their wedding, and the app clears ones older than a day.
CREATE TABLE "guest_import_results" (
    "weddingId" TEXT NOT NULL,
    "importKey" TEXT NOT NULL,
    "result" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "guest_import_results_pkey" PRIMARY KEY ("weddingId", "importKey")
);

CREATE INDEX "guest_import_results_createdAt_idx" ON "guest_import_results"("createdAt");

ALTER TABLE "guest_import_results" ADD CONSTRAINT "guest_import_results_weddingId_fkey"
  FOREIGN KEY ("weddingId") REFERENCES "weddings"("id") ON DELETE CASCADE ON UPDATE CASCADE;
