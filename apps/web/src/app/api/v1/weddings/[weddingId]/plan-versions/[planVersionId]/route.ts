import { NextRequest, NextResponse } from "next/server";
import { getPlanVersionDetail, setPlanVersionLabel } from "@seatwise/db";
import { setPlanVersionLabelSchema } from "@seatwise/shared";
import { getAuthUser } from "@/lib/session";
import { errorResponse, zodErrorResponse } from "@/lib/api-response";
import { requireAccess } from "@/lib/access";

type Params = { params: Promise<{ weddingId: string; planVersionId: string }> };

export async function GET(req: NextRequest, { params }: Params) {
  const user = await getAuthUser(req);
  if (!user) return errorResponse("Not authenticated", 401);

  const { weddingId, planVersionId } = await params;
  const access = await requireAccess(weddingId, user.id, "VIEW");
  if ("error" in access) return access.error;

  const planVersion = await getPlanVersionDetail(planVersionId, weddingId);
  if (!planVersion) return errorResponse("Plan version not found", 404);

  return NextResponse.json({ planVersion });
}

// TS-10/TS-12: rename/relabel a plan version so it's easier to tell apart than just its version
// number ("Family-approved draft", "Post-RSVP final"). Any collaborator who can edit the plan
// may relabel any version, current or not — a label is just a memory aid.
export async function PATCH(req: NextRequest, { params }: Params) {
  const user = await getAuthUser(req);
  if (!user) return errorResponse("Not authenticated", 401);

  const { weddingId, planVersionId } = await params;
  const access = await requireAccess(weddingId, user.id, "EDIT");
  if ("error" in access) return access.error;

  const body = await req.json().catch(() => null);
  const parsed = setPlanVersionLabelSchema.safeParse(body);
  if (!parsed.success) return zodErrorResponse(parsed.error);

  const planVersion = await setPlanVersionLabel(planVersionId, weddingId, parsed.data.label);
  if (!planVersion) return errorResponse("Plan version not found", 404);

  return NextResponse.json({ planVersion });
}
