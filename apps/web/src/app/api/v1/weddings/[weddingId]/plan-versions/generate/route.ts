import { NextRequest, NextResponse } from "next/server";
import {
  generateSeatingPlan,
  RULE_WEIGHT_CONFIG_VERSION,
  generatePlanVersionSchema,
  type EngineSideMixing,
  type EngineGuestTier,
  type EngineAgeCategory,
  type EnginePurposeCriterionType,
} from "@seatwise/shared";
import {
  listGuestsByWedding,
  listRelationshipsForWedding,
  listSeatingTablesForWedding,
  getLatestAssignmentsForWedding,
  createPlanVersionWithAssignments,
  getPlanVersionDetail,
  getWeddingById,
} from "@seatwise/db";
import { getAuthUser } from "@/lib/session";
import { errorResponse, zodErrorResponse, concurrentChangeResponse } from "@/lib/api-response";
import { requireAccess, canManageApproval, actorAccessFor } from "@/lib/access";
import { SAVED_AS_DRAFT_BECAUSE_APPROVED, MADE_CURRENT_BECAUSE_NO_CURRENT_PLAN } from "@/lib/plan-approval-text";
import { SAVED_BUT_NOT_REFRESHED, afterSave } from "@/lib/post-save";

type Params = { params: Promise<{ weddingId: string }> };

export async function POST(req: NextRequest, { params }: Params) {
  const user = await getAuthUser(req);
  if (!user) return errorResponse("Not authenticated", 401);

  const { weddingId } = await params;
  const access = await requireAccess(weddingId, user.id, "EDIT");
  if ("error" in access) return access.error;

  // FR-5.6: an empty/absent body defaults every field to unset, which the schema treats as
  // makeCurrent's own default (true) below -- existing callers that generate with no body at all
  // keep their old "always current" behavior unchanged.
  const body = await req.json().catch(() => ({}));
  const parsedBody = generatePlanVersionSchema.safeParse(body);
  if (!parsedBody.success) return zodErrorResponse(parsedBody.error);
  const makeCurrent = parsedBody.data.makeCurrent ?? true;

  const [wedding, guests, relationships, tables, currentAssignments] = await Promise.all([
    getWeddingById(weddingId),
    listGuestsByWedding(weddingId),
    listRelationshipsForWedding(weddingId),
    listSeatingTablesForWedding(weddingId),
    getLatestAssignmentsForWedding(weddingId),
  ]);
  if (!wedding) return errorResponse("Wedding not found", 404);
  const sideMixing = wedding.sideMixing as EngineSideMixing;

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

  // FR-3.7a: which Restricted table (if any) requires each guest — a hard pin at generation time.
  const requiredTableByGuestId = new Map<string, string>();
  for (const t of tables) {
    for (const guestId of t.requiredGuestIds) requiredTableByGuestId.set(guestId, t.id);
  }

  const result = generateSeatingPlan(
    attendingGuests.map((g) => ({
      id: g.id,
      name: `${g.firstName} ${g.lastName}`,
      headcount: g.headcount,
      requiresAccessibleTable: g.requiresAccessibleTable,
      isLocked: g.isLocked,
      currentTableId: currentAssignments.get(g.id) ?? null,
      side: g.side as "BRIDE" | "GROOM" | "BOTH",
      tier: g.tier as EngineGuestTier,
      ageCategory: g.ageCategory as EngineAgeCategory,
      requiredTableId: requiredTableByGuestId.get(g.id) ?? null,
    })),
    attendingRelationships.map((r) => ({ guestAId: r.guestAId, guestBId: r.guestBId, type: r.type })),
    tables.map((t) => ({
      id: t.id,
      label: t.label,
      capacity: t.capacity,
      isRestricted: t.isRestricted,
      isAccessible: t.isAccessible,
      isLocked: t.isLocked,
      singleSideOnly: t.singleSideOnly,
      // FR-3.7: a soft-preference input for generation only when both the type and value were
      // actually set on this table.
      purposeCriterion:
        t.purposeCriterionType && t.purposeCriterionValue
          ? {
              type: t.purposeCriterionType as EnginePurposeCriterionType,
              value: t.purposeCriterionValue,
            }
          : null,
    })),
    sideMixing
  );

  if (result.errors.length > 0) {
    // A genuine hard-rule contradiction — nothing was saved (FR-0.1: a direct violation is
    // blocked outright, saving nothing).
    return errorResponse("Can't generate a plan until these rule conflicts are resolved", 409, {
      conflicts: result.errors,
    });
  }

  // TS-179 (Tom's decision): someone who can't undo an approval can still generate, but if the
  // current plan is approved the result is saved as a comparison draft and the approved plan stays
  // current. The plan's status is checked again as the version is saved, under the wedding lock.
  const mayReplaceApproved = await canManageApproval(weddingId, user.id, access.accessLevel);

  let planVersionId: string;
  let savedAsDraftBecauseApproved: boolean;
  let madeCurrentBecauseNoCurrentPlan: boolean;
  try {
    // TS-173: the new version is re-checked table by table and recounted as it's saved, since
    // tables, rules or lists can change while the plan above was being worked out.
    // TS-189: a comparison draft asked for when there's no current plan is made current instead
    // (madeCurrentBecauseNoCurrentPlan) -- decided as it's saved, under the wedding lock.
    ({ planVersionId, savedAsDraftBecauseApproved, madeCurrentBecauseNoCurrentPlan } = await createPlanVersionWithAssignments(weddingId, {
      isComplete: result.isComplete,
      warnings: result.warnings,
      assignments: result.assignments,
      unassignedGuestIds: result.unassignedGuestIds,
      sideMixingSetting: sideMixing,
      ruleConfigVersion: RULE_WEIGHT_CONFIG_VERSION,
      makeCurrent,
      mayReplaceApproved,
      // TS-195: read again under the wedding lock -- refused if it dropped while this was worked out.
      actorAccess: await actorAccessFor(weddingId, user.id, access.accessLevel),
    }));
  } catch (err) {
    const conflict = concurrentChangeResponse(err);
    if (conflict) return conflict;
    throw err;
  }

  // TS-209: the plan is saved -- reading it back can't turn that into an error (it answered "Not
  // saved" and the new plan stayed hidden). Without it, the answer carries what the screen needs to
  // open the new version (its id, the engine's notes and who's unseated), plus a warning.
  const loadWarnings: string[] = [];
  const loaded = await afterSave("reading the new plan back", () => getPlanVersionDetail(planVersionId, weddingId), loadWarnings, SAVED_BUT_NOT_REFRESHED, null);
  const planVersion = loaded ?? { id: planVersionId, warnings: [] as string[], unassignedGuestIds: result.unassignedGuestIds };
  planVersion.warnings = [...result.warnings, ...(loaded ? [] : [SAVED_BUT_NOT_REFRESHED])];

  // FR-5.3: reported once, right alongside the version it was computed for -- same lifecycle as
  // `warnings` above (surfaced in this response only, not persisted for a later reload).
  return NextResponse.json(
    {
      planVersion,
      scoreReport: result.scoreReport,
      savedAsDraftBecauseApproved,
      madeCurrentBecauseNoCurrentPlan,
      ...(savedAsDraftBecauseApproved
        ? { notice: SAVED_AS_DRAFT_BECAUSE_APPROVED }
        : madeCurrentBecauseNoCurrentPlan
          ? { notice: MADE_CURRENT_BECAUSE_NO_CURRENT_PLAN }
          : {}),
    },
    { status: 201 }
  );
}
