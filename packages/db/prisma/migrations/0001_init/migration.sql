-- Seatwise initial schema
-- Hand-authored to exactly match packages/db/prisma/schema.prisma, table for table,
-- column for column, enum for enum. See README.md ("Database & Prisma in this environment")
-- for why this migration was applied by hand rather than via `prisma migrate dev`.
-- Once Prisma's engine binaries are reachable (any normal machine/CI), this history can be
-- adopted with: prisma migrate resolve --applied 0001_init

CREATE TYPE "WeddingStatus" AS ENUM ('PLANNING', 'APPROVED', 'ARCHIVED');
CREATE TYPE "GuestTier" AS ENUM ('VIP', 'FAMILY', 'FRIEND', 'PLUS_ONE', 'OTHER');
CREATE TYPE "RsvpStatus" AS ENUM ('PENDING', 'CONFIRMED', 'DECLINED');
CREATE TYPE "RelationshipType" AS ENUM ('MUST_SIT_TOGETHER', 'MUST_NOT_SIT_TOGETHER', 'PREFER_NEAR', 'AVOID');
CREATE TYPE "PlanVersionStatus" AS ENUM ('DRAFT', 'CURRENT', 'ARCHIVED');

CREATE TABLE "users" (
  "id" TEXT PRIMARY KEY,
  "email" TEXT NOT NULL UNIQUE,
  "passwordHash" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);

CREATE TABLE "weddings" (
  "id" TEXT PRIMARY KEY,
  "ownerId" TEXT NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "name" TEXT NOT NULL,
  "eventDate" DATE,
  "venueName" TEXT,
  "status" "WeddingStatus" NOT NULL DEFAULT 'PLANNING',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE INDEX "weddings_ownerId_idx" ON "weddings"("ownerId");

CREATE TABLE "guests" (
  "id" TEXT PRIMARY KEY,
  "weddingId" TEXT NOT NULL REFERENCES "weddings"("id") ON DELETE CASCADE,
  "firstName" TEXT NOT NULL,
  "lastName" TEXT NOT NULL,
  "partyName" TEXT,
  "headcount" INTEGER NOT NULL DEFAULT 1,
  "tier" "GuestTier" NOT NULL DEFAULT 'OTHER',
  "rsvpStatus" "RsvpStatus" NOT NULL DEFAULT 'PENDING',
  "requiresAccessibleTable" BOOLEAN NOT NULL DEFAULT FALSE,
  "notes" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE INDEX "guests_weddingId_idx" ON "guests"("weddingId");

CREATE TABLE "guest_relationships" (
  "id" TEXT PRIMARY KEY,
  "weddingId" TEXT NOT NULL REFERENCES "weddings"("id") ON DELETE CASCADE,
  "guestAId" TEXT NOT NULL REFERENCES "guests"("id") ON DELETE CASCADE,
  "guestBId" TEXT NOT NULL REFERENCES "guests"("id") ON DELETE CASCADE,
  "type" "RelationshipType" NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("weddingId", "guestAId", "guestBId", "type")
);
CREATE INDEX "guest_relationships_weddingId_idx" ON "guest_relationships"("weddingId");

CREATE TABLE "seating_tables" (
  "id" TEXT PRIMARY KEY,
  "weddingId" TEXT NOT NULL REFERENCES "weddings"("id") ON DELETE CASCADE,
  "label" TEXT NOT NULL,
  "capacity" INTEGER NOT NULL,
  "isRestricted" BOOLEAN NOT NULL DEFAULT FALSE,
  "purpose" TEXT,
  "positionX" DOUBLE PRECISION,
  "positionY" DOUBLE PRECISION,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE INDEX "seating_tables_weddingId_idx" ON "seating_tables"("weddingId");

CREATE TABLE "plan_versions" (
  "id" TEXT PRIMARY KEY,
  "weddingId" TEXT NOT NULL REFERENCES "weddings"("id") ON DELETE CASCADE,
  "versionNumber" INTEGER NOT NULL,
  "label" TEXT,
  "status" "PlanVersionStatus" NOT NULL DEFAULT 'DRAFT',
  "isComplete" BOOLEAN NOT NULL DEFAULT FALSE,
  "restoredFromId" TEXT REFERENCES "plan_versions"("id"),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("weddingId", "versionNumber")
);
CREATE INDEX "plan_versions_weddingId_idx" ON "plan_versions"("weddingId");

CREATE TABLE "seat_assignments" (
  "id" TEXT PRIMARY KEY,
  "planVersionId" TEXT NOT NULL REFERENCES "plan_versions"("id") ON DELETE CASCADE,
  "guestId" TEXT NOT NULL REFERENCES "guests"("id") ON DELETE CASCADE,
  "seatingTableId" TEXT NOT NULL REFERENCES "seating_tables"("id") ON DELETE CASCADE,
  "needsReassignment" BOOLEAN NOT NULL DEFAULT FALSE,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  UNIQUE ("planVersionId", "guestId")
);
CREATE INDEX "seat_assignments_planVersionId_idx" ON "seat_assignments"("planVersionId");

CREATE TABLE "change_history_entries" (
  "id" TEXT PRIMARY KEY,
  "planVersionId" TEXT NOT NULL REFERENCES "plan_versions"("id") ON DELETE CASCADE,
  "action" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "actorUserId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "change_history_entries_planVersionId_idx" ON "change_history_entries"("planVersionId");

CREATE TABLE "rule_weight_configs" (
  "id" TEXT PRIMARY KEY,
  "weddingId" TEXT NOT NULL REFERENCES "weddings"("id") ON DELETE CASCADE,
  "version" INTEGER NOT NULL,
  "config" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("weddingId", "version")
);
