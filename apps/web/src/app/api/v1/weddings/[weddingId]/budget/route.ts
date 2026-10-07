import { NextRequest, NextResponse } from "next/server";
import { setBudgetSchema } from "@seatwise/shared";
import { getBudgetSummaryForWedding, setBudgetForWedding, BudgetConflictError } from "@seatwise/db";
import { getAuthUser } from "@/lib/session";
import { errorResponse, zodErrorResponse, readJson, weddingDeletedResponse } from "@/lib/api-response";
import { requireAccess } from "@/lib/access";
import { afterSave, SAVED_BUT_NOT_REFRESHED } from "@/lib/post-save";

type Params = { params: Promise<{ weddingId: string }> };

// TS-20 (FR-15.2): the running-total/remaining view -- EDIT-gated the same as the vendors list
// itself (see that route's own comment for why this isn't an owner-only setting).
export async function GET(req: NextRequest, { params }: Params) {
  const user = await getAuthUser(req);
  if (!user) return errorResponse("Not authenticated", 401);

  const { weddingId } = await params;
  const access = await requireAccess(weddingId, user.id, "VIEW");
  if ("error" in access) return access.error;

  const summary = await getBudgetSummaryForWedding(weddingId);
  return NextResponse.json({ summary });
}

export async function PATCH(req: NextRequest, { params }: Params) {
  const user = await getAuthUser(req);
  if (!user) return errorResponse("Not authenticated", 401);

  const { weddingId } = await params;
  const access = await requireAccess(weddingId, user.id, "EDIT");
  if ("error" in access) return access.error;

  // TS-204: readJson refuses a non-JSON or oversized body (413), even one sent without a Content-Length.
  const json = await readJson(req);
  if (!json.ok) return json.response;
  const body = json.body;
  const parsed = setBudgetSchema.safeParse(body);
  if (!parsed.success) return zodErrorResponse(parsed.error);

  try {
    await setBudgetForWedding(weddingId, parsed.data.budgetCents, parsed.data.expectedRevision, access.actor);
  } catch (err) {
    // TS-92: stale save -- refused, with the current figure so the UI can show the latest.
    if (err instanceof BudgetConflictError) {
      const summary = await getBudgetSummaryForWedding(weddingId);
      return NextResponse.json({ error: err.message, summary }, { status: 409 });
    }
    // TS-204: access dropped while it waited (403), or the wedding was deleted (404) -- nothing saved.
    const refused = weddingDeletedResponse(err);
    if (refused) return refused;
    throw err;
  }
  // TS-209: the budget is saved by now -- if reading the totals back fails, that's said as a warning
  // (with no totals), never as an error the planner would take to mean it wasn't saved.
  const warnings: string[] = [];
  const summary = await afterSave(
    "reading the budget totals back",
    () => getBudgetSummaryForWedding(weddingId),
    warnings,
    SAVED_BUT_NOT_REFRESHED,
    null
  );
  return NextResponse.json({ summary, warnings });
}
