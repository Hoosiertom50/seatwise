-- AlterTable
ALTER TABLE "guests" ADD COLUMN     "revision" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "seating_tables" ADD COLUMN     "revision" INTEGER NOT NULL DEFAULT 0;
