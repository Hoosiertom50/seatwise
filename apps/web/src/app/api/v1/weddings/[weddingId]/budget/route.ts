import { NextRequest, NextResponse } from "next/server";
import { setBudgetSchema } from "@seatwise/shared";
import { getBudgetSummaryForWedding, setBudgetForWedding } from "@seatwise/db";
import { getAuthUser } from "@/lib/session";
import { errorResponse, zodErrorResponse } from "@/lib/api-response";
import { requireAccess } from "@/lib/access";

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

  const body = await req.json().catch(() => null);
  const parsed = setBudgetSchema.safeParse(body);
  if (!parsed.success) return zodErrorResponse(parsed.error);

  await setBudgetForWedding(weddingId, parsed.data.budgetCents);
  const summary = await getBudgetSummaryForWedding(weddingId);
  return NextResponse.json({ summary });
}
