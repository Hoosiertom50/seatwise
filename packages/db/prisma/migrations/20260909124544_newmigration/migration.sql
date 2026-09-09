/*
  Warnings:

  - You are about to drop the column `revision` on the `guests` table. All the data in the column will be lost.
  - You are about to drop the column `revision` on the `seating_tables` table. All the data in the column will be lost.

*/
-- DropForeignKey
ALTER TABLE "change_history_entries" DROP CONSTRAINT "change_history_entries_planVersionId_fkey";

-- DropForeignKey
ALTER TABLE "guest_relationships" DROP CONSTRAINT "guest_relationships_guestAId_fkey";

-- DropForeignKey
ALTER TABLE "guest_relationships" DROP CONSTRAINT "guest_relationships_guestBId_fkey";

-- DropForeignKey
ALTER TABLE "guest_relationships" DROP CONSTRAINT "guest_relationships_weddingId_fkey";

-- DropForeignKey
ALTER TABLE "guests" DROP CONSTRAINT "guests_weddingId_fkey";

-- DropForeignKey
ALTER TABLE "plan_versions" DROP CONSTRAINT "plan_versions_restoredFromId_fkey";

-- DropForeignKey
ALTER TABLE "plan_versions" DROP CONSTRAINT "plan_versions_weddingId_fkey";

-- DropForeignKey
ALTER TABLE "rule_weight_configs" DROP CONSTRAINT "rule_weight_configs_weddingId_fkey";

-- DropForeignKey
ALTER TABLE "seat_assignments" DROP CONSTRAINT "seat_assignments_guestId_fkey";

-- DropForeignKey
ALTER TABLE "seat_assignments" DROP CONSTRAINT "seat_assignments_planVersionId_fkey";

-- DropForeignKey
ALTER TABLE "seat_assignments" DROP CONSTRAINT "seat_assignments_seatingTableId_fkey";

-- DropForeignKey
ALTER TABLE "seating_tables" DROP CONSTRAINT "seating_tables_weddingId_fkey";

-- DropForeignKey
ALTER TABLE "weddings" DROP CONSTRAINT "weddings_ownerId_fkey";

-- AlterTable
ALTER TABLE "guests" DROP COLUMN "revision";

-- AlterTable
ALTER TABLE "seating_tables" DROP COLUMN "revision";

-- AddForeignKey
ALTER TABLE "weddings" ADD CONSTRAINT "weddings_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guests" ADD CONSTRAINT "guests_weddingId_fkey" FOREIGN KEY ("weddingId") REFERENCES "weddings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guest_relationships" ADD CONSTRAINT "guest_relationships_weddingId_fkey" FOREIGN KEY ("weddingId") REFERENCES "weddings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guest_relationships" ADD CONSTRAINT "guest_relationships_guestAId_fkey" FOREIGN KEY ("guestAId") REFERENCES "guests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guest_relationships" ADD CONSTRAINT "guest_relationships_guestBId_fkey" FOREIGN KEY ("guestBId") REFERENCES "guests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "seating_tables" ADD CONSTRAINT "seating_tables_weddingId_fkey" FOREIGN KEY ("weddingId") REFERENCES "weddings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plan_versions" ADD CONSTRAINT "plan_versions_weddingId_fkey" FOREIGN KEY ("weddingId") REFERENCES "weddings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plan_versions" ADD CONSTRAINT "plan_versions_restoredFromId_fkey" FOREIGN KEY ("restoredFromId") REFERENCES "plan_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "seat_assignments" ADD CONSTRAINT "seat_assignments_planVersionId_fkey" FOREIGN KEY ("planVersionId") REFERENCES "plan_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "seat_assignments" ADD CONSTRAINT "seat_assignments_guestId_fkey" FOREIGN KEY ("guestId") REFERENCES "guests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "seat_assignments" ADD CONSTRAINT "seat_assignments_seatingTableId_fkey" FOREIGN KEY ("seatingTableId") REFERENCES "seating_tables"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "change_history_entries" ADD CONSTRAINT "change_history_entries_planVersionId_fkey" FOREIGN KEY ("planVersionId") REFERENCES "plan_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rule_weight_configs" ADD CONSTRAINT "rule_weight_configs_weddingId_fkey" FOREIGN KEY ("weddingId") REFERENCES "weddings"("id") ON DELETE CASCADE ON UPDATE CASCADE;
