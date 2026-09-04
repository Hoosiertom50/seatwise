import { NextRequest, NextResponse } from "next/server";
import { generateSeatingPlan } from "@seatwise/shared";
import {
  getWeddingForOwner,
  listGuestsByWedding,
  listRelationshipsForWedding,
  listSeatingTablesForWedding,
  getLatestAssignmentsForWedding,
  createPlanVersionWithAssignments,
  getPlanVersionDetail,
} from "@seatwise/db";
import { getAuthUser } from "@/lib/session";
import { errorResponse } from "@/lib/api-response";

type Params = { params: Promise<{ weddingId: string }> };

export async function POST(req: NextRequest, { params }: Params) {
  const user = await getAuthUser(req);
  if (!user) return errorResponse("Not authenticated", 401);

  const { weddingId } = await params;
  const wedding = await getWeddingForOwner(weddingId, user.id);
  if (!wedding) return errorResponse("Wedding not found", 404);

  const [guests, relationships, tables, currentAssignments] = await Promise.all([
    listGuestsByWedding(weddingId),
    listRelationshipsForWedding(weddingId),
    listSeatingTablesForWedding(weddingId),
    getLatestAssignmentsForWedding(weddingId),
  ]);

  if (guests.length === 0) {
    return errorResponse("Add some guests before generating a seating plan.", 422);
  }
  if (tables.length === 0) {
    return errorResponse("Add some tables before generating a seating plan.", 422);
  }

  // FR-8.1: a guest marked Not Attending isn't part of today's plan at all — they don't occupy a
  // seat, don't count toward completeness, and don't participate in relationship rules. Their
  // relationships are dropped too (not just filtered from the guest list) since the engine's
  // union-find would otherwise choke on a rule referencing a guest who was never added to it.
  const attendingGuests = guests.filter((g) => g.dayOfAttendance === "ATTENDING");
  const attendingIds = new Set(attendingGuests.map((g) => g.id));
  const attendingRelationships = relationships.filter(
    (r) => attendingIds.has(r.guestAId) && attendingIds.has(r.guestBId)
  );

  const result = generateSeatingPlan(
    attendingGuests.map((g) => ({
      id: g.id,
      name: `${g.firstName} ${g.lastName}`,
      headcount: g.headcount,
      requiresAccessibleTable: g.requiresAccessibleTable,
      isLocked: g.isLocked,
      currentTableId: currentAssignments.get(g.id) ?? null,
    })),
    attendingRelationships.map((r) => ({ guestAId: r.guestAId, guestBId: r.guestBId, type: r.type })),
    tables.map((t) => ({
      id: t.id,
      label: t.label,
      capacity: t.capacity,
      isRestricted: t.isRestricted,
      isAccessible: t.isAccessible,
      isLocked: t.isLocked,
    }))
  );

  if (result.errors.length > 0) {
    // A genuine hard-rule contradiction — nothing was saved (FR-0.1: a direct violation is
    // blocked outright, saving nothing).
    return errorResponse("Can't generate a plan until these rule conflicts are resolved", 409, {
      conflicts: result.errors,
    });
  }

  const planVersionId = await createPlanVersionWithAssignments(weddingId, {
    isComplete: result.isComplete,
    warnings: result.warnings,
    assignments: result.assignments,
    unassignedGuestIds: result.unassignedGuestIds,
  });

  const planVersion = await getPlanVersionDetail(planVersionId, weddingId);
  if (!planVersion) {
    return errorResponse("Plan was generated but couldn't be loaded back", 500);
  }
  planVersion.warnings = result.warnings;

  return NextResponse.json({ planVersion }, { status: 201 });
}
