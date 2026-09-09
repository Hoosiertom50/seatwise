-- TS-19 (FR-14.1/FR-14.2): reusable table-layout + rule-shape templates. A template belongs to
-- the planner who saved it (ownerId), not to any one wedding, and never stores anything
-- guest-specific -- see the model comments in schema.prisma for the full reasoning.

CREATE TABLE "seating_templates" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sourceWeddingId" TEXT,
    "sideMixing" "SideMixingSetting" NOT NULL DEFAULT 'BALANCED_MIX',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "seating_templates_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "seating_templates_ownerId_idx" ON "seating_templates"("ownerId");

ALTER TABLE "seating_templates" ADD CONSTRAINT "seating_templates_ownerId_fkey"
    FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ON DELETE SET NULL: a template outlives the wedding it was captured from -- it's a standalone,
-- reusable asset, never a live link back to its source (see schema.prisma comment).
ALTER TABLE "seating_templates" ADD CONSTRAINT "seating_templates_sourceWeddingId_fkey"
    FOREIGN KEY ("sourceWeddingId") REFERENCES "weddings"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "seating_template_tables" (
    "id" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "capacity" INTEGER NOT NULL,
    "isRestricted" BOOLEAN NOT NULL DEFAULT false,
    "isAccessible" BOOLEAN NOT NULL DEFAULT false,
    "isLocked" BOOLEAN NOT NULL DEFAULT false,
    "purpose" TEXT,
    "purposeCriterionType" "TablePurposeCriterionType",
    "purposeCriterionValue" TEXT,
    "singleSideOnly" BOOLEAN NOT NULL DEFAULT false,
    "shape" "TableShape" NOT NULL DEFAULT 'ROUND',
    "positionX" DOUBLE PRECISION,
    "positionY" DOUBLE PRECISION,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "seating_template_tables_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "seating_template_tables_templateId_idx" ON "seating_template_tables"("templateId");

ALTER TABLE "seating_template_tables" ADD CONSTRAINT "seating_template_tables_templateId_fkey"
    FOREIGN KEY ("templateId") REFERENCES "seating_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;
