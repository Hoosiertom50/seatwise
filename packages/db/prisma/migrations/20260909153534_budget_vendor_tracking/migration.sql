-- TS-20 (FR-15.1/FR-15.2): budget & vendor tracking. Money is always integer cents (never a
-- float) -- see the Vendor model comment in schema.prisma for why.

CREATE TYPE "VendorCategory" AS ENUM (
    'CATERING', 'VENUE', 'FLORIST', 'PHOTOGRAPHY', 'VIDEOGRAPHY', 'MUSIC_ENTERTAINMENT',
    'ATTIRE', 'CAKE_BAKERY', 'RENTALS', 'TRANSPORTATION', 'STATIONERY', 'OTHER'
);

-- FR-15.2: null means no budget has been set yet.
ALTER TABLE "weddings" ADD COLUMN "budgetCents" INTEGER;

CREATE TABLE "vendors" (
    "id" TEXT NOT NULL,
    "weddingId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" "VendorCategory" NOT NULL,
    "categoryOther" TEXT,
    "contactName" TEXT,
    "contactEmail" TEXT,
    "contactPhone" TEXT,
    "costCents" INTEGER,
    "contractNotes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "vendors_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "vendors_weddingId_idx" ON "vendors"("weddingId");

ALTER TABLE "vendors" ADD CONSTRAINT "vendors_weddingId_fkey"
    FOREIGN KEY ("weddingId") REFERENCES "weddings"("id") ON DELETE CASCADE ON UPDATE CASCADE;
