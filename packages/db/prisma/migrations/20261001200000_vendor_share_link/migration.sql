-- TS-114: a vendor's arrival time, and their private read-only link.
ALTER TABLE "vendors" ADD COLUMN "arrivalTime" TEXT;
ALTER TABLE "vendors" ADD COLUMN "shareToken" TEXT;
CREATE UNIQUE INDEX "vendors_shareToken_key" ON "vendors"("shareToken");
