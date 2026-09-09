-- TS-7 (Table & Venue Layout), FR-4.1: a table's shape affects only how the floor plan draws it,
-- never seating logic. positionX/positionY (FR-4.3) already existed in this table from an
-- earlier pass; this migration only adds what was still missing.

CREATE TYPE "TableShape" AS ENUM ('ROUND', 'RECTANGULAR', 'SQUARE', 'OVAL', 'OTHER');

ALTER TABLE "seating_tables" ADD COLUMN "shape" "TableShape" NOT NULL DEFAULT 'ROUND';
