import { NextRequest, NextResponse } from "next/server";
import { createVendorSchema } from "@seatwise/shared";
import { createVendor, listVendorsForWedding } from "@seatwise/db";
import { getAuthUser } from "@/lib/session";
import { errorResponse, zodErrorResponse } from "@/lib/api-response";
import { requireAccess } from "@/lib/access";

type Params = { params: Promise<{ weddingId: string }> };

// TS-20 (FR-15.1): vendor tracking follows the same View/Comment/Edit access rules as every other
// working tab (guests, tables, timeline) -- it's ordinary planner data entry, not an
// administrative wedding setting like rename/collaborators/note, so it's never owner-only.
export async function GET(req: NextRequest, { params }: Params) {
  const user = await getAuthUser(req);
  if (!user) return errorResponse("Not authenticated", 401);

  const { weddingId } = await params;
  const access = await requireAccess(weddingId, user.id, "VIEW");
  if ("error" in access) return access.error;

  const vendors = await listVendorsForWedding(weddingId);
  // TS-172 (Tom's decision, 2026-10-05): a vendor's contract notes are for the owner and Edit
  // collaborators only. View and Comment still see costs, contacts and the budget.
  const canSeeContractNotes = access.accessLevel === "OWNER" || access.accessLevel === "EDIT";
  return NextResponse.json({
    vendors: canSeeContractNotes ? vendors : vendors.map((v) => ({ ...v, contractNotes: null })),
  });
}

export async function POST(req: NextRequest, { params }: Params) {
  const user = await getAuthUser(req);
  if (!user) return errorResponse("Not authenticated", 401);

  const { weddingId } = await params;
  const access = await requireAccess(weddingId, user.id, "EDIT");
  if ("error" in access) return access.error;

  const body = await req.json().catch(() => null);
  const parsed = createVendorSchema.safeParse(body);
  if (!parsed.success) return zodErrorResponse(parsed.error);

  const vendor = await createVendor(weddingId, parsed.data);
  return NextResponse.json({ vendor }, { status: 201 });
}
