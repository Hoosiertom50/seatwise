-- TS-98: fixed-window request counters for rate-limiting public, unauthenticated endpoints (the
-- guest RSVP link first). Kept in the database rather than in server memory so the limit holds
-- on any host -- serverless platforms run many short-lived instances that share no memory.
-- Rows are tiny and short-lived; old windows are pruned opportunistically by the query layer.

CREATE TABLE "rate_limit_counters" (
  "key" TEXT NOT NULL,
  "windowStart" TIMESTAMP(3) NOT NULL,
  "count" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "rate_limit_counters_pkey" PRIMARY KEY ("key", "windowStart")
);

CREATE INDEX "rate_limit_counters_windowStart_idx" ON "rate_limit_counters" ("windowStart");
